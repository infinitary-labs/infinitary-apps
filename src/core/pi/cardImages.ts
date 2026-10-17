import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CARD_MEDIA_TYPES,
  CARD_TYPEFACE_TYPES,
  type CardMediaExtension,
  type CardPictureExtension,
  type CardTypefaceExtension,
  cardMediaFileName,
  cardMediaUrl,
  cardPictureFileName,
  cardPictureUrl,
  cardTypefaceFileName,
  cardTypefaceUrl,
  isPictureTaskId,
} from "@shared/cardPictures";
import type { CardDemo, CardPicture } from "@shared/cards";
import { hasHook, hasHookClass, hookAttributes, hookValue } from "@shared/codeNames";
import { Parser } from "htmlparser2";
import { readFont } from "../fontFormat";
import { isGif, MAX_GIF_DEMO_BYTES, readDemoGif } from "../gifFormat";
import { type PictureFormat, type PictureSize, readPicture } from "../pictureFormat";
import { readDemoVideo } from "../videoFormat";
import { fontFaceUrls } from "./fontFaces";

/**
 * Pictures by reference (card pictures, phase 2 of the locked plan; captain's
 * rounds 1-4 on `fm3000-card-images-proposal-s1`). A picture is markup: an
 * `<img src="<working-copy path>" alt="<what it proves>">` wherever it belongs
 * in the body, and several inside `<figure class="inf-pictures">` are one
 * group. The host walks the body with the parser the card lint uses, verifies
 * every picture that names a working-copy path, copies the verified bytes
 * under the task, and rewrites ONLY that tag's `src` (to the frame scheme's
 * `images` host), `width` and `height` (from the file's own header) - every
 * other byte of the body stays verbatim. One failure refuses the card.
 *
 * A picture named by a URL - a `data:` picture the body carries itself, or
 * any other scheme - is not a working-copy path and is left exactly as
 * written: the body renders verbatim and the frame is the boundary (captain
 * decision 2026-09-15, direction C), which loads `data:` and the host's own
 * copies and nothing else.
 *
 * A demo recording (docs/card-authoring.md "Demo recordings") is markup too:
 * `<figure data-inf-demo="<path to an MP4 or a GIF>">` holding exactly one `<img>`, its
 * poster - a frame of the recording - and usually a `<figcaption>`. The host
 * verifies the recording and its poster as one attachment: the poster as any
 * picture, the recording's boxes (`readDemoVideo`), the poster's shape
 * against the recording's, and frames decoded from its start, middle and end
 * by the host's isolated probe (`MediaProbe`). A recording that is a GIF -
 * the single-play fallback when no MP4 could be made - is read instead by
 * `readDemoGif`, whose walk decodes every frame and refuses a loop
 * instruction, and goes through no probe. It copies the recording beside
 * the pictures and rewrites only that figure's `data-inf-demo` (to the frame
 * scheme's `media` host) and `data-inf-demo-duration` (from the file). A
 * recording is never named by a URL: one that is refuses the card.
 *
 * A project's font (docs/card-authoring.md "Fonts by reference") is markup
 * too: a `url()` naming a font file inside an `@font-face` rule of a
 * `<style>` element (`./fontFaces`). The host checks the file's own
 * structure (`readFont`), loads all of a card's fonts in its own font
 * engine (`TypefaceProbe`), copies each beside the pictures under a name its
 * own bytes give it, and rewrites only that `url()` (to the frame scheme's
 * `typefaces` host). A font named by a URL is left as written, as a
 * picture is: the frame loads none.
 */

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
/** The largest demo recording a card may play; a GIF's own cap is `MAX_GIF_DEMO_BYTES`. */
export const MAX_DEMO_BYTES = 16 * 1024 * 1024;
/** The only cap on a card's pictures and recordings: their total size. There is no count cap. */
export const MAX_CARD_PICTURE_BYTES = 64 * 1024 * 1024;

/** The attribute that makes a figure a demo, naming its recording. */
export const DEMO_ATTRIBUTE = "data-inf-demo";
/** The attribute the host writes on a demo figure: how long its recording plays, in milliseconds. */
export const DEMO_DURATION_ATTRIBUTE = "data-inf-demo-duration";

/**
 * How long the host's probe may take over one recording before the card is
 * refused: a recording that cannot show three frames in this long is not
 * one the captain can play.
 */
export const MEDIA_PROBE_DEADLINE_MS = 5_000;
/** A refusal's words for a recording the probe could not play; a scripted stand-in recognizes them. */
export const DEMO_UNPLAYED_WORDS = "did not play back";

/** What the probe decoded: the size Chromium shows and how long it plays. */
export type MediaProbeResult =
  | { ok: true; width: number; height: number; durationMs: number }
  | { ok: false; reason: string };

/**
 * The host's isolated decoder (`src/main/mediaProbe.ts`): it plays the
 * bytes in a window of its own, with no network, sign-in or app bridge, and
 * reports whether frames at the start, middle and end decoded. The core
 * stays free of Electron, so the host hands this in.
 */
export type MediaProbe = (recording: {
  bytes: Buffer;
  contentType: (typeof CARD_MEDIA_TYPES)["mp4"];
}) => Promise<MediaProbeResult>;

/** The largest project font a card may name; it counts toward the card's total with its pictures. */
export const MAX_TYPEFACE_BYTES = 8 * 1024 * 1024;

/** A refusal's words for a font the host's font engine could not load; a scripted stand-in recognizes them. */
export const TYPEFACE_UNREAD_WORDS = "could not be read by the font engine";

/** What the host's font engine made of a project font: it loaded, or why it did not. */
export type TypefaceProbeResult = { ok: true } | { ok: false; reason: string };

/**
 * The host's isolated font loader (`src/main/mediaProbe.ts`): it loads a
 * card's fonts as web fonts, all in one window of its own, with no network,
 * sign-in or app bridge, through the same sanitizer a card's frame uses,
 * within `MEDIA_PROBE_DEADLINE_MS`, and answers one result per font in the
 * order given. The core stays free of Electron, so the host hands this in.
 */
export type TypefaceProbe = (
  typefaces: readonly {
    bytes: Buffer;
    contentType: (typeof CARD_TYPEFACE_TYPES)[CardTypefaceExtension];
  }[],
) => Promise<TypefaceProbeResult[]>;

/** The class that makes a figure one group of pictures (the frame stylesheet lays it out). */
export const PICTURE_GROUP_CLASS = "inf-pictures";

/** Where a crewmate's pictures come from and where the host keeps its copies. */
export type CardPictureRoot = {
  /** The working copy a picture's path is relative to. */
  worktree: string;
  /**
   * `crewmates/<taskId>/cards`: the host's copies, which outlive the evidence
   * folder they came from (only the Settings purge removes them).
   */
  dir: string;
  taskId: string;
  /**
   * `crewmates/<taskId>/evidence`: the task's evidence folder on this machine,
   * outside every project. A picture may also be named by an absolute path
   * inside it, so evidence never has to live in (or be committed from) the
   * working copy.
   */
  evidenceDir?: string;
  /** The host's decoder for demo recordings; absent, a card that names one is refused. */
  probe?: MediaProbe;
  /** The host's font loader for project fonts; absent, a card that names one is refused. */
  typefaceProbe?: TypefaceProbe;
};

/**
 * The root a crewmate's cards name pictures from: its own working copy and
 * its evidence folder, and its task's folder for the copies. Absent when the
 * spec has no folder.
 */
export function cardPictureRoot(spec: {
  taskId?: string;
  cwd?: string;
  picturesDir?: string;
  evidenceDir?: string;
  probeMedia?: MediaProbe;
  probeTypeface?: TypefaceProbe;
}): CardPictureRoot | undefined {
  return spec.picturesDir && spec.cwd && spec.taskId
    ? {
        worktree: spec.cwd,
        dir: spec.picturesDir,
        taskId: spec.taskId,
        ...(spec.evidenceDir ? { evidenceDir: spec.evidenceDir } : {}),
        ...(spec.probeMedia ? { probe: spec.probeMedia } : {}),
        ...(spec.probeTypeface ? { typefaceProbe: spec.probeTypeface } : {}),
      }
    : undefined;
}

export type VerifiedCardBody = { body: string; pictures: CardPicture[] };

type Sized = PictureSize;
type Format = PictureFormat & { extension: CardPictureExtension };

/** One `<img>` the walk found, with the byte range of its start tag. */
type FoundImage = {
  start: number;
  end: number;
  attribs: [string, string][];
  /** The group's key: its figure's offset, or the picture's own when it stands alone. */
  groupKey: string;
};

/** One `figure[data-inf-demo]` the walk found: its start tag's range and the pictures inside it. */
type FoundDemo = {
  start: number;
  end: number;
  attribs: [string, string][];
  /** Indexes into the walk's pictures of every `<img>` inside the figure. */
  images: number[];
};

type FoundTag = { start: number; end: number; attribs: [string, string][] };

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function attribute(tag: FoundTag, name: string): string | undefined {
  return tag.attribs.find(([key]) => key === name)?.[1];
}

type Found = {
  images: FoundImage[];
  demos: FoundDemo[];
  /** Elements other than a figure that carry `data-inf-demo`, by tag name. */
  misplaced: string[];
  /** Whether a demo figure sits inside another. */
  nested: boolean;
  /** Each `<style>` element's sheet: the byte range of its text in the body. */
  styles: { start: number; end: number }[];
};

/** Every `<img>` in the body, in order, each tagged with its group, and every demo figure. */
function findImages(body: string): Found {
  const found: Found = { images: [], demos: [], misplaced: [], nested: false, styles: [] };
  // Open figures, innermost last: whether each is a group, where it starts, and its demo.
  const figures: { group: boolean; start: number; demo?: FoundDemo }[] = [];
  // The sheet of the style element open now; its text arrives raw, maybe in pieces.
  let sheet: { start: number; end: number } | undefined;
  const parser = new Parser(
    {
      ontext() {
        if (!sheet) return;
        if (sheet.end === sheet.start) sheet.start = parser.startIndex;
        sheet.end = parser.endIndex + 1;
      },
      onopentag(name, attribs) {
        if (name === "style") {
          sheet = { start: parser.endIndex + 1, end: parser.endIndex + 1 };
          return;
        }
        const isDemo = hasHook(attribs, "demo");
        if (isDemo && name !== "figure") found.misplaced.push(name);
        if (name === "figure") {
          let demo: FoundDemo | undefined;
          if (isDemo) {
            if (figures.some((figure) => figure.demo)) found.nested = true;
            demo = {
              start: parser.startIndex,
              end: parser.endIndex + 1,
              attribs: Object.entries(attribs),
              images: [],
            };
            found.demos.push(demo);
          }
          figures.push({
            group: hasHookClass(attribs.class, "pictures"),
            start: parser.startIndex,
            ...(demo ? { demo } : {}),
          });
          return;
        }
        if (name !== "img") return;
        const figure = figures.at(-1);
        for (const open of figures) open.demo?.images.push(found.images.length);
        found.images.push({
          start: parser.startIndex,
          end: parser.endIndex + 1,
          // htmlparser2 keeps attributes in source order.
          attribs: Object.entries(attribs),
          groupKey: figure?.group ? `figure:${figure.start}` : `img:${parser.startIndex}`,
        });
      },
      onclosetag(name) {
        if (name === "figure") figures.pop();
        if (name === "style" && sheet) {
          if (sheet.end > sheet.start) found.styles.push(sheet);
          sheet = undefined;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(body);
  parser.end();
  return found;
}

/** Whether a `src` is a URL rather than a path: a scheme (`data:`, `https:`) or protocol-relative. */
function isUrl(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

type Verified = { file: string; bytes: Buffer; format: Format; size: Sized };

/** The folders a picture may come from: the working copy, and the evidence folder when it exists. */
type PictureHomes = { worktree: string; evidence?: string };

/**
 * The real file a path names, held to its home: a relative path inside the
 * working copy, an absolute one inside the evidence folder, through every
 * symlink. `what` names the refusal ("Card picture refused").
 */
async function containedFile(src: string, homes: PictureHomes, what: string): Promise<string> {
  if (isAbsolute(src) && !homes.evidence) {
    throw new Error(`${what}: src must be a path relative to the task's working copy.`);
  }
  let file: string;
  try {
    file = await realpath(resolve(homes.worktree, src));
  } catch {
    throw new Error(`${what}: file not found: ${src}`);
  }
  const allowed = isAbsolute(src)
    ? homes.evidence !== undefined && isInside(homes.evidence, file)
    : isInside(homes.worktree, file);
  if (!allowed) {
    throw new Error(
      isAbsolute(src)
        ? `${what}: an absolute path must stay inside the task's evidence folder.`
        : `${what}: path must stay inside the task's working copy.`,
    );
  }
  return file;
}

async function verifyPicture(src: string, alt: string, homes: PictureHomes): Promise<Verified> {
  if (isAbsolute(src) && !homes.evidence) {
    throw new Error(
      "Card picture refused: src must be a path relative to the task's working copy.",
    );
  }
  if (!alt.trim()) {
    throw new Error(`Card picture refused: ${src} needs alt text saying what it proves.`);
  }
  const file = await containedFile(src, homes, "Card picture refused");
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_PICTURE_BYTES) {
    throw new Error(
      `Card picture refused: ${src} must be a regular file no larger than ${MAX_PICTURE_BYTES / 1024 / 1024}MB.`,
    );
  }
  const bytes = await readFile(file);
  const read = readPicture(bytes);
  if (read) return { file, bytes, ...read };
  if (isGif(bytes)) {
    throw new Error(
      `Card picture refused: ${src} is a GIF; a GIF moves, so it is a demo: name it in <figure ${DEMO_ATTRIBUTE}="${src}"> with a still PNG of it as its poster.`,
    );
  }
  throw new Error(`Card picture refused: ${src} is not a structurally valid PNG, JPEG or WebP.`);
}

/** What the host read from a recording: its kind, and the size and length it plays at. */
type DemoRead = { kind: CardMediaExtension; width: number; height: number; durationMs: number };

type VerifiedDemo = { file: string; bytes: Buffer; read: DemoRead };

/** A probe's decoded size and length agree with what the boxes state, within rounding. */
function probeAgrees(
  video: DemoRead,
  probe: { width: number; height: number; durationMs: number },
) {
  const sized = probe.width === video.width && probe.height === video.height;
  const slack = Math.max(500, video.durationMs * 0.1);
  return sized && Math.abs(probe.durationMs - video.durationMs) <= slack;
}

/**
 * One demo's recording, checked as its own file and against its poster: a
 * contained regular file within its kind's size cap, then either a demo MP4
 * by its boxes with three frames the host's probe decoded, or a single-play
 * GIF demo by its walk, and in both the poster's shape.
 */
async function verifyDemo(
  src: string,
  poster: Sized,
  homes: PictureHomes,
  probe: MediaProbe | undefined,
): Promise<VerifiedDemo> {
  const what = "Card demo refused";
  const file = await containedFile(src, homes, what);
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_DEMO_BYTES) {
    throw new Error(
      `${what}: ${src} must be a regular file no larger than ${MAX_DEMO_BYTES / 1024 / 1024}MB; shorten it or lower its quality.`,
    );
  }
  const bytes = await readFile(file);
  const gif = isGif(bytes) || /\.gif$/i.test(src);
  if (gif && bytes.length > MAX_GIF_DEMO_BYTES) {
    throw new Error(
      `${what}: ${src} is a GIF larger than ${MAX_GIF_DEMO_BYTES / 1024 / 1024}MB; shorten it or make it smaller.`,
    );
  }
  let read: DemoRead;
  if (gif) {
    const walked = readDemoGif(bytes);
    if (!walked.ok) throw new Error(`${what}: ${src} ${walked.reason}.`);
    read = { kind: "gif", ...walked.gif };
  } else {
    const boxes = readDemoVideo(bytes);
    if (!boxes.ok) throw new Error(`${what}: ${src} ${boxes.reason}.`);
    read = { kind: "mp4", ...boxes.video };
  }
  const shape = read.width / read.height;
  if (Math.abs(poster.width / poster.height - shape) / shape > 0.02) {
    throw new Error(
      `${what}: its poster is ${poster.width} × ${poster.height}, which is not the shape of ${src} (${read.width} × ${read.height}); use a frame of the recording as its poster.`,
    );
  }
  // A GIF's walk decoded every frame; an MP4's boxes say nothing of its pictures.
  if (read.kind === "gif") return { file, bytes, read };
  if (!probe) {
    throw new Error(
      `${what}: this app cannot play a recording here to check it, so show still pictures instead.`,
    );
  }
  let decoded: MediaProbeResult;
  try {
    decoded = await probe({ bytes, contentType: CARD_MEDIA_TYPES.mp4 });
  } catch (error) {
    decoded = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!decoded.ok) {
    throw new Error(`${what}: ${src} ${DEMO_UNPLAYED_WORDS}: ${decoded.reason}`);
  }
  if (!probeAgrees(read, decoded)) {
    throw new Error(
      `${what}: ${src} played back at ${decoded.width} × ${decoded.height} for ${(decoded.durationMs / 1000).toFixed(1)} seconds, not the ${read.width} × ${read.height} and ${(read.durationMs / 1000).toFixed(1)} seconds it states; encode it again.`,
    );
  }
  return { file, bytes, read };
}

/** A project font file, read once: the spelling it was first named by, its real file, its bytes and kind. */
type VerifiedTypeface = { src: string; file: string; bytes: Buffer; kind: CardTypefaceExtension };

const TYPEFACE_REFUSED = "Card font refused";

/**
 * One project font file, checked as its own file: a contained regular file
 * within the size cap and a font by its own structure (`readFont`). The
 * bytes read here are the ones loaded, counted and copied, so a file
 * changed after the check is never what a frame draws.
 */
async function readTypeface(src: string, file: string): Promise<VerifiedTypeface> {
  const tooLarge = () =>
    new Error(
      `${TYPEFACE_REFUSED}: ${src} must be a regular font file no larger than ${MAX_TYPEFACE_BYTES / 1024 / 1024}MB; name a smaller subset of it.`,
    );
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_TYPEFACE_BYTES) throw tooLarge();
  const bytes = await readFile(file);
  if (bytes.length > MAX_TYPEFACE_BYTES) throw tooLarge();
  const read = readFont(bytes);
  if (!read.ok) throw new Error(`${TYPEFACE_REFUSED}: ${src} ${read.reason}.`);
  return { src, file, bytes, kind: read.kind };
}

/**
 * Every font a card names, loaded together by the host's font engine in one
 * window (`TypefaceProbe`): the first that does not load refuses the card,
 * named by the spelling the body gave it.
 */
async function loadTypefaces(
  typefaces: readonly VerifiedTypeface[],
  probe: TypefaceProbe | undefined,
): Promise<void> {
  if (typefaces.length === 0) return;
  if (!probe) {
    throw new Error(
      `${TYPEFACE_REFUSED}: this app cannot load a font here to check it, so draw the preview in the app's own typefaces.`,
    );
  }
  let loaded: TypefaceProbeResult[];
  try {
    loaded = await probe(
      typefaces.map(({ bytes, kind }) => ({ bytes, contentType: CARD_TYPEFACE_TYPES[kind] })),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    loaded = typefaces.map(() => ({ ok: false, reason }));
  }
  typefaces.forEach((typeface, index) => {
    const result = loaded[index] ?? { ok: false, reason: "it was not loaded" };
    if (!result.ok) {
      throw new Error(
        `${TYPEFACE_REFUSED}: ${typeface.src} ${TYPEFACE_UNREAD_WORDS}: ${result.reason}. Name an undamaged copy of the font, or another of its files.`,
      );
    }
  });
}

/**
 * Keeps `bytes` at `file`, a name drawn from those bytes: a file there that
 * already holds exactly them is left alone, and anything else is replaced
 * whole, through a temporary file renamed over it, so a frame reading the
 * name never meets a copy cut short. The temporary name is no minted name,
 * so no host ever serves it.
 */
export function keepContentFile(file: string, bytes: Buffer): void {
  try {
    if (readFileSync(file).equals(bytes)) return;
  } catch {
    // Nothing kept by that name yet.
  }
  const temporary = `${file}.${randomBytes(8).toString("hex")}.partial`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The name a font's copy is kept under: the task, then 32 hex of the bytes'
 * own SHA-256, as `keepPictureFile` names a picture - so the same font keeps
 * one name in every version of a card, and a revision that leaves it alone
 * leaves its style sheet's text alone too.
 */
function typefaceId(taskId: string, bytes: Buffer): string {
  return `${taskId}-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}

/**
 * A demo figure's rewrite: the minted recording and its length under this
 * build's names, and under another spelling's too where the author wrote
 * that one (`@shared/codeNames`), so no path in the working copy stays.
 */
function demoRewrite(demo: FoundTag, src: string, durationMs: number): Map<string, string> {
  const written = new Set(demo.attribs.map(([key]) => key));
  const rewrite = new Map([
    [DEMO_ATTRIBUTE, src],
    [DEMO_DURATION_ATTRIBUTE, String(durationMs)],
  ]);
  hookAttributes("demo").forEach((attribute, i) => {
    if (!written.has(attribute)) return;
    rewrite.set(attribute, src);
    rewrite.set(hookAttributes("demo-duration")[i] as string, String(durationMs));
  });
  return rewrite;
}

/** A start tag with only the named attributes rewritten (or added), every other byte of it kept. */
function rewrittenStartTag(name: string, tag: FoundTag, rewrite: Map<string, string>): string {
  const values = new Map(rewrite);
  const parts = tag.attribs.map(([key, value]) => {
    const next = values.get(key);
    values.delete(key);
    return `${key}="${escapeAttribute(next ?? value)}"`;
  });
  for (const [key, value] of values) parts.push(`${key}="${escapeAttribute(value)}"`);
  return `<${name} ${parts.join(" ")}>`;
}

/** The picture's start tag with only `src`, `width` and `height` rewritten. */
function rewrittenTag(image: FoundImage, src: string, size: Sized): string {
  return rewrittenStartTag(
    "img",
    image,
    new Map([
      ["src", src],
      ["width", String(size.width)],
      ["height", String(size.height)],
    ]),
  );
}

/**
 * Verify, copy and rewrite every picture, demo recording and project font a
 * card body names. `root` is absent where there is no working copy to name a
 * file from (the Firstmate's own cards): a body there may still carry
 * `data:` pictures, and one that names a path is refused.
 *
 * Every file is verified before any is copied, so a refused card leaves
 * nothing behind; each copy is written from the bytes that were verified, so
 * a file swapped after the check is never what the captain sees.
 */
export async function verifyCardImages(
  body: string,
  root: CardPictureRoot | undefined,
  /** A staging caller owns each newly minted picture/recording, including a failed write. */
  onCopy?: (file: string) => void,
): Promise<VerifiedCardBody> {
  const found = findImages(body);
  const isNamed = (image: FoundImage) => {
    const src = attribute(image, "src")?.trim() ?? "";
    return src !== "" && !isUrl(src);
  };
  if (found.misplaced.length > 0) {
    throw new Error(
      `Card demo refused: ${DEMO_ATTRIBUTE} belongs on the <figure> that holds the demo's poster, not on a <${found.misplaced[0]}>.`,
    );
  }
  if (found.nested) {
    throw new Error("Card demo refused: a demo figure cannot sit inside another demo figure.");
  }
  // Each demo: its recording's path, and the one picture inside it, its poster.
  const demos = found.demos.map((demo) => {
    const src = hookValue(Object.fromEntries(demo.attribs), "demo")?.trim() ?? "";
    if (!src || isUrl(src)) {
      throw new Error(
        `Card demo refused: ${DEMO_ATTRIBUTE} names the recording's file - a path in the working copy, or an absolute path in the task's evidence folder - never a URL.`,
      );
    }
    const poster = demo.images[0];
    const image = poster === undefined ? undefined : found.images[poster];
    if (demo.images.length !== 1 || !image || !isNamed(image)) {
      throw new Error(
        `Card demo refused: the demo figure for ${src} holds exactly one <img>, its poster - a frame of the recording named by its file path - beside its <figcaption>.`,
      );
    }
    return { demo, src, poster: poster as number };
  });
  const named = found.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => isNamed(image));
  // Each font a style sheet's @font-face names by a path, with its url() token's range in the body.
  const fonts = found.styles
    .flatMap(({ start, end }) =>
      fontFaceUrls(body.slice(start, end)).map((url) => ({
        start: start + url.start,
        end: start + url.end,
        src: url.value.trim(),
      })),
    )
    .filter(({ src }) => src !== "" && !isUrl(src));
  if (named.length === 0 && fonts.length === 0) return { body, pictures: [] };
  if (!root) {
    throw new Error(
      named.length > 0
        ? "Card picture refused: there is no working copy here to name a picture from; draw the figure in the body instead."
        : "Card font refused: there is no working copy here to name a font file from; draw the body in the app's own typefaces.",
    );
  }
  if (!isPictureTaskId(root.taskId)) {
    throw new Error(
      named.length > 0
        ? "Card picture refused: this task cannot keep pictures."
        : "Card font refused: this task cannot keep font files.",
    );
  }

  const worktree = await realpath(root.worktree);
  // A missing evidence folder just means there is nothing to name from it.
  const evidence = root.evidenceDir
    ? await realpath(root.evidenceDir).catch(() => undefined)
    : undefined;
  const homes: PictureHomes = { worktree, ...(evidence ? { evidence } : {}) };
  const tooMuch = () =>
    new Error(
      `Card picture refused: a card's pictures, recordings and fonts may total at most ${MAX_CARD_PICTURE_BYTES / 1024 / 1024}MB; show fewer or smaller ones.`,
    );
  const verified = new Map<number, Verified>();
  let total = 0;
  for (const { image, index } of named) {
    const picture = await verifyPicture(
      attribute(image, "src")?.trim() ?? "",
      attribute(image, "alt") ?? "",
      homes,
    );
    total += picture.bytes.length;
    if (total > MAX_CARD_PICTURE_BYTES) throw tooMuch();
    verified.set(index, picture);
  }
  const recordings = new Map<number, VerifiedDemo>();
  for (const { src, poster } of demos) {
    const recording = await verifyDemo(
      src,
      (verified.get(poster) as Verified).size,
      homes,
      root.probe,
    );
    total += recording.bytes.length;
    if (total > MAX_CARD_PICTURE_BYTES) throw tooMuch();
    recordings.set(poster, recording);
  }
  // Each font file once, however many rules name it and however its path
  // is spelled: read, counted and loaded once.
  const typefaces = new Map<string, VerifiedTypeface>();
  const files = new Map<string, VerifiedTypeface>();
  for (const { src } of fonts) {
    if (typefaces.has(src)) continue;
    const file = await containedFile(src, homes, TYPEFACE_REFUSED);
    let typeface = files.get(file);
    if (!typeface) {
      typeface = await readTypeface(src, file);
      files.set(file, typeface);
      total += typeface.bytes.length;
      if (total > MAX_CARD_PICTURE_BYTES) throw tooMuch();
    }
    typefaces.set(src, typeface);
  }
  await loadTypefaces([...files.values()], root.typefaceProbe);

  await mkdir(root.dir, { recursive: true });
  const mint = () => `${root.taskId}-${randomBytes(16).toString("hex")}`;
  // One copy per file, however many times the body names it.
  const copies = new Map<string, string>();
  const recordingCopies = new Map<string, CardDemo>();
  const groups = new Map<string, number>();
  const pictures: CardPicture[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  for (const { poster, demo } of demos) {
    const recording = recordings.get(poster) as VerifiedDemo;
    let copy = recordingCopies.get(recording.file);
    if (!copy) {
      const id = mint();
      const { kind } = recording.read;
      const file = join(root.dir, cardMediaFileName(id, kind));
      onCopy?.(file);
      await writeFile(file, recording.bytes);
      copy = {
        id,
        kind,
        width: recording.read.width,
        height: recording.read.height,
        durationMs: recording.read.durationMs,
        bytes: recording.bytes.length,
        sha256: createHash("sha256").update(recording.bytes).digest("hex"),
      };
      recordingCopies.set(recording.file, copy);
    }
    edits.push({
      start: demo.start,
      end: demo.end,
      text: rewrittenStartTag(
        "figure",
        demo,
        demoRewrite(demo, cardMediaUrl(copy.id, copy.kind), copy.durationMs),
      ),
    });
  }
  for (const { image, index } of named) {
    const picture = verified.get(index) as Verified;
    let id = copies.get(picture.file);
    if (!id) {
      id = mint();
      const file = join(root.dir, cardPictureFileName(id, picture.format.extension));
      onCopy?.(file);
      await writeFile(file, picture.bytes);
      copies.set(picture.file, id);
    }
    let group = groups.get(image.groupKey);
    if (group === undefined) {
      group = groups.size;
      groups.set(image.groupKey, group);
    }
    const recording = recordings.get(index);
    pictures.push({
      id,
      sha256: createHash("sha256").update(picture.bytes).digest("hex"),
      alt: (attribute(image, "alt") ?? "").trim(),
      width: picture.size.width,
      height: picture.size.height,
      group,
      ...(recording ? { demo: recordingCopies.get(recording.file) as CardDemo } : {}),
    });
    edits.push({
      start: image.start,
      end: image.end,
      text: rewrittenTag(image, cardPictureUrl(id, picture.format.extension), picture.size),
    });
  }
  const typefaceCopies = new Map<string, string>();
  for (const font of fonts) {
    const typeface = typefaces.get(font.src) as VerifiedTypeface;
    let url = typefaceCopies.get(typeface.file);
    if (!url) {
      const id = typefaceId(root.taskId, typeface.bytes);
      keepContentFile(join(root.dir, cardTypefaceFileName(id, typeface.kind)), typeface.bytes);
      url = cardTypefaceUrl(id, typeface.kind);
      typefaceCopies.set(typeface.file, url);
    }
    edits.push({ start: font.start, end: font.end, text: `url("${url}")` });
  }
  edits.sort((a, b) => a.start - b.start);
  let rewritten = "";
  let cursor = 0;
  for (const edit of edits) {
    rewritten += body.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  rewritten += body.slice(cursor);
  return { body: rewritten, pictures };
}

/** A picture the host copied for a card it writes itself: what the body names it by, and its size. */
export type KeptPicture = { id: string; src: string; width: number; height: number };

/**
 * A picture the host itself names (the startup note's hero pictures,
 * docs/release-notes.md), checked the way a crewmate's picture is - a
 * regular file within the size cap, a structurally valid PNG, JPEG or WebP -
 * and copied under `root.dir` by its own content, so the same picture keeps
 * one copy however many notes name it. Synchronous, because the startup note
 * commits before the window's first card snapshot. Undefined when the file
 * is missing or refused: the caller draws no picture.
 */
export function keepPictureFile(
  file: string,
  root: { dir: string; taskId: string },
): KeptPicture | undefined {
  if (!isPictureTaskId(root.taskId)) return undefined;
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_PICTURE_BYTES) return undefined;
    const bytes = readFileSync(file);
    const read = readPicture(bytes);
    if (!read) return undefined;
    const id = `${root.taskId}-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
    const extension = read.format.extension;
    const copy = join(root.dir, cardPictureFileName(id, extension));
    if (!existsSync(copy)) {
      mkdirSync(root.dir, { recursive: true });
      writeFileSync(copy, bytes);
    }
    return { id, src: cardPictureUrl(id, extension), ...read.size };
  } catch {
    return undefined;
  }
}
