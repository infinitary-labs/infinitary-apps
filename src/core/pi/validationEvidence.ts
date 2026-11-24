import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  CARD_MEDIA_KINDS,
  type CardMediaExtension,
  type CardPictureExtension,
  cardMediaUrl,
  cardPictureUrl,
} from "@shared/cardPictures";
import type {
  KeptValidationInput,
  LiveValidationInput,
  ValidationEvidence,
} from "@shared/liveValidation";
import {
  type CardPictureRoot,
  containedFile,
  restoreKeptCopy,
  verifyCardImages,
} from "./cardImages";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const attribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
/** The selected kinds a run record keeps, by extension; only a picture's is checked as an image. */
const TEXT_EXTENSIONS = [".txt", ".json", ".log"];
const PICTURE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const RECORDING_EXTENSIONS = CARD_MEDIA_KINDS.map((kind) => `.${kind}`);
/** Keep selected proof with the existing contained picture/media owner, not seven-day scratch. */
export async function keepValidationEvidence(
  input: LiveValidationInput,
  root: CardPictureRoot | undefined,
): Promise<KeptValidationInput> {
  if (input.kind !== "run") return input;
  if (input.evidence.length === 0) return { ...input, evidence: [] };
  if (!root) throw new Error("This task has no isolated folder in which to keep validation proof.");
  const evidenceHome = root.evidenceDir
    ? await realpath(root.evidenceDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const homes = {
    worktree: await realpath(root.worktree),
    ...(evidenceHome ? { evidence: evidenceHome } : {}),
  };
  const evidence: ValidationEvidence[] = [];
  let total = 0;
  let textTotal = 0;
  for (const source of input.evidence) {
    const extension = extname(source.path).toLowerCase();
    const moving = RECORDING_EXTENSIONS.includes(extension);
    if (!moving && !PICTURE_EXTENSIONS.includes(extension) && !TEXT_EXTENSIONS.includes(extension))
      throw new Error(
        `Validation evidence refused: ${source.path} is not a kind a run record keeps. Keep text as a .txt, .json or .log file, a picture as a PNG, JPEG or WebP, and a recording as an MP4 or GIF with its poster.`,
      );
    if (TEXT_EXTENSIONS.includes(extension)) {
      const file = await containedFile(source.path, homes, "Validation evidence refused");
      const info = await stat(file);
      if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024)
        throw new Error(
          "Keep a selected text transcript of at most 1 MB, never a database or a folder.",
        );
      const bytes = await readFile(file);
      textTotal += bytes.length;
      if (textTotal > 1024 * 1024)
        throw new Error("Keep at most 1 MB of selected text across one validation report.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0"))
        throw new Error("Validation transcripts must be text, not binary data.");
      const sha256 = digest(bytes);
      const name = `${root.taskId}-${sha256}${extension}`;
      await mkdir(root.dir, { recursive: true });
      await writeFile(join(root.dir, name), bytes, { flag: "wx", mode: 0o600 }).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST" || digest(await readFile(join(root.dir, name))) !== sha256)
            throw error;
        },
      );
      evidence.push({
        id: source.id,
        description: source.description,
        digest: sha256,
        bytes: bytes.length,
        file: name,
        text,
      });
    } else {
      if (moving && !source.poster)
        throw new Error("A validation recording needs its still poster.");
      const image = `<img src="${attribute(moving ? source.poster! : source.path)}" alt="${attribute(source.description)}">`;
      const body = moving
        ? `<figure data-inf-demo="${attribute(source.path)}">${image}</figure>`
        : image;
      const kept = await verifyCardImages(body, root);
      const picture = kept.pictures[0];
      if (!picture?.sha256)
        throw new Error("The selected proof was not kept as a verified attachment.");
      const name = (await readdir(root.dir)).find((name) => name.startsWith(`${picture.id}.`));
      if (!name) throw new Error("The kept picture is missing.");
      const pictureUrl = cardPictureUrl(picture.id, extname(name).slice(1) as CardPictureExtension);
      const attachment = picture.demo;
      const file = attachment ? `${attachment.id}.${attachment.kind}` : name;
      const bytes = await readFile(join(root.dir, file));
      if (attachment) total += (await stat(join(root.dir, name))).size;
      evidence.push({
        id: source.id,
        description: source.description,
        digest: attachment?.sha256 ?? picture.sha256,
        bytes: bytes.length,
        file,
        picture: pictureUrl,
        ...(attachment
          ? {
              media: cardMediaUrl(attachment.id, attachment.kind),
              durationMs: attachment.durationMs,
              posterFile: name,
              posterDigest: picture.sha256,
            }
          : {}),
      });
    }
    total += evidence.at(-1)!.bytes;
    if (total > 64 * 1024 * 1024)
      throw new Error(
        "Selected validation proof exceeds 64 MB; keep the smallest artifacts that demonstrate the claims.",
      );
  }
  return { ...input, evidence };
}

/**
 * Where a kept proof file is, or the refusal naming the way out when it is
 * gone: a missing copy is never a bare file-system error (INF-3323).
 */
function keptPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Kept validation proof is missing; record and review fresh evidence.");
    throw error;
  }
}

/** The last send boundary is synchronous: it must not yield between its guard and dispatch. */
export function verifyKeptValidationEvidenceSync(
  evidence: ValidationEvidence[],
  dir: string,
  taskId: string,
): void {
  if (!evidence.length) return;
  const home = keptPath(dir);
  let total = 0;
  let textTotal = 0;
  for (const item of evidence) {
    const extension = extname(item.file).slice(1);
    const moving = extension === "mp4" || extension === "gif";
    const text = ["txt", "json", "log"].includes(extension);
    if (text) {
      if (item.picture || item.media || item.posterFile)
        throw new Error("A text proof must show only its kept transcript.");
    } else {
      const poster = moving ? item.posterFile : item.file;
      if (
        !poster ||
        item.picture !==
          cardPictureUrl(
            basename(poster, extname(poster)),
            extname(poster).slice(1) as CardPictureExtension,
          )
      )
        throw new Error("The displayed picture must be the kept proof.");
      if (moving && item.media !== cardMediaUrl(basename(item.file, extname(item.file)), extension))
        throw new Error("The displayed recording must be the kept proof.");
      if (!moving && (item.media || item.posterFile || item.text !== undefined))
        throw new Error("The proof's media type changed.");
    }
    for (const [file, expected] of [
      [item.file, item.digest],
      ...(item.posterFile ? [[item.posterFile, item.posterDigest]] : []),
    ]) {
      if (!file || !expected || basename(file) !== file || !file.startsWith(`${taskId}-`))
        throw new Error("The proof does not belong to this task.");
      // An identical copy left in the folder stands in for a lost one (INF-3672).
      restoreKeptCopy(home, file, {
        taskId,
        sha256: expected,
        ...(file === item.file ? { bytes: item.bytes } : {}),
      });
      const path = keptPath(join(home, file));
      if (dirname(path) !== home) throw new Error("Kept proof must stay in its task's folder.");
      const info = statSync(path);
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw new Error("Kept proof exceeds its allowed size.");
      total += info.size;
      if (total > 64 * 1024 * 1024) throw new Error("Selected validation proof exceeds 64 MB.");
      const bytes = readFileSync(path);
      if (file === item.file && bytes.length !== item.bytes)
        throw new Error("Kept proof has a different byte count.");
      if (
        file === item.file &&
        item.text !== undefined &&
        !bytes.equals(Buffer.from(item.text, "utf8"))
      )
        throw new Error("The transcript does not match the kept bytes.");
      if (file === item.file && text) {
        textTotal += bytes.length;
        if (textTotal > 1024 * 1024)
          throw new Error("Kept transcripts exceed 1 MB in this report.");
        const transcript = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (bytes.length > 1024 * 1024 || transcript.includes("\0"))
          throw new Error("Kept transcripts must be text of at most 1 MB.");
      }
      if (digest(bytes) !== expected)
        throw new Error("Kept validation proof changed; record and review fresh evidence.");
    }
  }
}

/** Re-read the selected bytes at review and delivery, never a mutable source path. */
export async function verifyKeptValidationEvidence(
  evidence: ValidationEvidence[],
  dir: string,
  taskId: string,
): Promise<void> {
  verifyKeptValidationEvidenceSync(evidence, dir, taskId);
}

/** Presentation reads text only. Digest verification remains uncached at review and delivery gates. */
export function readKeptValidationEvidence(
  evidence: ValidationEvidence[],
  dir: string,
  taskId: string,
): ValidationEvidence[] {
  let total = 0;
  return evidence.map((item) => {
    if (!TEXT_EXTENSIONS.includes(extname(item.file))) return item;
    try {
      if (basename(item.file) !== item.file || !item.file.startsWith(`${taskId}-`))
        throw new Error("The proof does not belong to this task.");
      const home = realpathSync(dir);
      const path = realpathSync(join(home, item.file));
      if (dirname(path) !== home) throw new Error("Kept proof must stay in its task's folder.");
      const info = statSync(path);
      total += info.size;
      if (!info.isFile() || info.size !== item.bytes || total > 1024 * 1024)
        throw new Error("Keep only selected text of at most 1 MB.");
      const bytes = readFileSync(path);
      if (bytes.length !== item.bytes) throw new Error("The transcript changed during its read.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("The transcript is not text.");
      return { ...item, text };
    } catch {
      return {
        ...item,
        text: "The kept proof is missing or changed. Record and review fresh evidence.",
      };
    }
  });
}

/**
 * A takeover's copy of the proof an earlier task kept (INF-6536 finding 3):
 * each kept file is checked where it is, then copied into the takeover's
 * own folder under its id, so every later gate reads it as that task's own
 * (`verifyKeptValidationEvidenceSync` holds proof to its task's folder and
 * name). A copy already there with the same bytes stands.
 */
export function carryKeptValidationEvidence(
  evidence: ValidationEvidence[],
  from: { dir: string; taskId: string },
  to: { dir: string; taskId: string },
): ValidationEvidence[] {
  if (!evidence.length) return [];
  verifyKeptValidationEvidenceSync(evidence, from.dir, from.taskId);
  const renamed = (file: string) => `${to.taskId}-${file.slice(from.taskId.length + 1)}`;
  mkdirSync(to.dir, { recursive: true });
  const home = keptPath(from.dir);
  const carried = evidence.map((item) => {
    for (const file of [item.file, ...(item.posterFile ? [item.posterFile] : [])]) {
      const target = join(to.dir, renamed(file));
      try {
        copyFileSync(join(home, file), target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!readFileSync(target).equals(readFileSync(join(home, file))))
          throw new Error("A different file already holds this proof's name.");
      }
    }
    const file = renamed(item.file);
    const posterFile = item.posterFile ? renamed(item.posterFile) : undefined;
    const poster = posterFile ?? file;
    const moving = posterFile !== undefined;
    return {
      ...item,
      file,
      ...(posterFile ? { posterFile } : {}),
      ...(item.picture
        ? {
            picture: cardPictureUrl(
              basename(poster, extname(poster)),
              extname(poster).slice(1) as CardPictureExtension,
            ),
          }
        : {}),
      ...(moving && item.media
        ? {
            media: cardMediaUrl(
              basename(file, extname(file)),
              extname(file).slice(1) as CardMediaExtension,
            ),
          }
        : {}),
    };
  });
  verifyKeptValidationEvidenceSync(carried, to.dir, to.taskId);
  return carried;
}
