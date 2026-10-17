import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { type CardPictureRoot, verifyCardImages } from "./cardImages";

export type { StagedChangePresentation } from "@shared/changePresentation";

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
            "GitHub stories need an inspected MP4 recording; a GIF or still is not substituted.",
          );
        if (demo.bytes >= 10_000_000)
          throw new Error(
            "GitHub recordings must be below 10 MB. Make and inspect a smaller copy before preparing again.",
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
    const views = draft.views.map((view) => {
      const before = media.slice(cursor, cursor + view.before.length);
      cursor += view.before.length;
      const after = media.slice(cursor, cursor + view.after.length);
      cursor += view.after.length;
      return {
        id: view.id,
        caption: view.caption,
        kind: view.kind,
        ...(view.layout ? { layout: view.layout } : {}),
        before,
        after,
      };
    });
    const { publishable: _publishable, views: _sourceViews, ...story } = draft;
    return {
      version: 1,
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
