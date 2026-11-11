import { createHash } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { CARD_PICTURE_TYPES } from "@shared/cardPictures";
import {
  type ChangePresentationDraft,
  changePresentationDraftSchema,
  type PresentationAsset,
  type PresentationMedia,
  type RetainedPresentationMedia,
  type StagedChangePresentation,
} from "@shared/changePresentation";
import { presentationHtmlText } from "../forge";
import { type CardPictureRoot, containedFile, verifyCardImages } from "./cardImages";

export type { StagedChangePresentation } from "@shared/changePresentation";

const MAP_REFUSED = "Story map refused";

/**
 * A map view's data block, read from the file the author named and packed
 * as the map part reads a packed block (`docs/forge.md`, "A map view").
 */
async function packedMap(src: string, root: CardPictureRoot): Promise<string> {
  const evidence = root.evidenceDir
    ? await realpath(root.evidenceDir).catch(() => undefined)
    : undefined;
  const file = await containedFile(
    src,
    { worktree: await realpath(root.worktree), ...(evidence ? { evidence } : {}) },
    MAP_REFUSED,
  );
  const info = await stat(file);
  // Map data deflates to about a tenth of its size, so a larger file would not fit the
  // story's 60,000-character limit; reading it whole would only spend memory.
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error(`${MAP_REFUSED}: ${src} must be a file of at most 1 MB.`);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`${MAP_REFUSED}: ${src} is not JSON.`);
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // A single map file is the likely wrong file: the part reads the whole data block.
  if (!record(data) || !record(data.maps) || Object.keys(data.maps).length === 0)
    throw new Error(
      `${MAP_REFUSED}: ${src} must hold the map part's filled data block, { "maps": { "<folder>": <its map file> }, "compare": [...] }, not a single map file.`,
    );
  if (!Array.isArray(data.compare) || data.compare.length === 0)
    throw new Error(
      `${MAP_REFUSED}: ${src} needs a comparison in "compare" for the change view to draw.`,
    );
  return deflateRawSync(Buffer.from(JSON.stringify(data))).toString("base64");
}

/** Validate selected bytes using the existing card reader, without displaying a card. */
export async function stageChangePresentation(
  input: ChangePresentationDraft,
  root: CardPictureRoot,
): Promise<StagedChangePresentation> {
  const draft = changePresentationDraftSchema.parse(input);
  const selected = draft.views.flatMap((view) => [...view.before, ...view.after]);
  // These figures are generated solely from typed selected paths, never arbitrary author HTML.
  const body = selected
    .map((media) => {
      const text = presentationHtmlText;
      return `<figure${media.poster ? ` data-inf-demo="${text(media.path)}"` : ""}><img src="${text(media.poster ?? media.path)}" alt="${text(media.alt)}"></figure>`;
    })
    .join("\n");
  const copies = new Set<string>();
  try {
    const verified = await verifyCardImages(body, root, (file) => copies.add(file));
    if (verified.pictures.length !== selected.length)
      throw new Error("Evidence must name contained local files, never URLs or embedded data.");
    const assets: PresentationAsset[] = [];
    const add = (asset: PresentationAsset) => {
      if (!assets.some((kept) => kept.id === asset.id)) assets.push(asset);
    };
    const media: RetainedPresentationMedia[] = [];
    for (const [index, picture] of verified.pictures.entries()) {
      const source = selected[index] as PresentationMedia;
      let image: PresentationAsset | undefined;
      for (const [extension, mediaType] of Object.entries(CARD_PICTURE_TYPES)) {
        const file = `${picture.id}.${extension}`;
        const bytes = await readFile(join(root.dir, file)).catch(() => undefined);
        if (!bytes) continue;
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== picture.sha256)
          throw new Error("The retained image changed during preparation.");
        image = {
          id: picture.id,
          file,
          mediaType,
          sourceSha256: digest,
          uploadSha256: digest,
          bytes: bytes.length,
          width: picture.width,
          height: picture.height,
        };
        break;
      }
      if (!image) throw new Error("The retained image is unavailable.");
      add(image);
      if (picture.demo) {
        const demo = picture.demo;
        if (demo.kind !== "mp4")
          throw new Error(
            "Saved stories need an inspected MP4 recording; a GIF or still is not substituted.",
          );
        if (demo.bytes >= 10_000_000)
          throw new Error(
            "Story recordings must be below 10 MB. Make and inspect a smaller copy before preparing again.",
          );
        add({
          id: demo.id,
          file: `${demo.id}.mp4`,
          mediaType: "video/mp4",
          sourceSha256: demo.sha256,
          uploadSha256: demo.sha256,
          width: demo.width,
          height: demo.height,
          bytes: demo.bytes,
          durationMs: demo.durationMs,
        });
      }
      media.push({
        asset: picture.demo?.id ?? picture.id,
        ...(picture.demo ? { poster: picture.id } : {}),
        alt: source.alt,
        captureHead: source.captureHead,
        ...(source.applicability ? { applicability: source.applicability } : {}),
      });
    }
    let cursor = 0;
    const views: StagedChangePresentation["views"] = [];
    for (const view of draft.views) {
      const before = media.slice(cursor, cursor + view.before.length);
      cursor += view.before.length;
      const after = media.slice(cursor, cursor + view.after.length);
      cursor += view.after.length;
      views.push({
        id: view.id,
        caption: view.caption,
        kind: view.kind,
        ...(view.layout ? { layout: view.layout } : {}),
        ...(view.map === undefined ? {} : { map: await packedMap(view.map, root) }),
        before,
        after,
      });
    }
    const { publishable: _publishable, views: _sourceViews, ...story } = draft;
    return {
      version: 2,
      ...story,
      projectText: story.projectText ?? "",
      views,
      assets,
      pictures: verified.pictures,
    };
  } catch (caught) {
    await Promise.all(
      [...copies].map(async (file) => {
        await rm(file, { force: true }).catch((error: unknown) => {
          console.warn("Could not remove refused story staging copy", error);
        });
      }),
    );
    throw caught;
  }
}
