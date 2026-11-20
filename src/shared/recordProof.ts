import { playableDemoKind, viewablePictures } from "@shared/cardPictures";
import type { LiveValidationSummary } from "@shared/liveValidationSummary";
import type { FrameDemo, FramePicture } from "@shared/plugins/bridge";

/** INF-125: the record opens only its retained proof, through the existing viewer. */
export function recordProofPictures(
  proof: LiveValidationSummary | undefined,
  index: number,
  pictures: FramePicture[],
) {
  const kept = new Set(proof?.rows.flatMap((row) => row.evidence.map((item) => item.picture)));
  if (!pictures.every((picture) => kept.has(picture.src))) return undefined;
  return viewablePictures(index, pictures);
}

export function recordProofDemo(
  proof: LiveValidationSummary | undefined,
  request: FrameDemo,
  pressed: boolean,
) {
  const kept = proof?.rows
    .flatMap((row) => row.evidence)
    .find((item) => item.media === request.src && item.picture === request.poster.src);
  const kind = playableDemoKind(request.src);
  const poster = recordProofPictures(proof, 0, [request.poster]);
  if (!kept || !kind || !poster) return undefined;
  return {
    ...poster,
    demo: {
      src: request.src,
      kind,
      caption: kept.description,
      durationMs: kept.durationMs ?? 0,
      play: request.play && pressed,
    },
  };
}
