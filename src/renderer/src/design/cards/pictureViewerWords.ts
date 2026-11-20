import * as m from "@shared/i18n/messages.generated";
/**
 * What the picture viewer's player reads in place of its time when a
 * recording cannot play (`PictureViewer.tsx`), in English for the tests; the
 * viewer calls the message when it draws.
 */
export const RECORDING_UNPLAYABLE = m.uiPictureViewerUnplayable();

/**
 * Why a picture that fits at its own size has no Actual size to go to
 * (`PictureViewer.tsx`), in English for the tests; the viewer calls the
 * message when it draws.
 */
export const SHOWN_AT_OWN_SIZE = m.uiPictureViewerShownAtOwnSize();

/** A picture's own size, "1600 × 400". */
export function pictureSize(size: { width: number; height: number }): string {
  return `${size.width} × ${size.height}`;
}

/** The hint under a picture: its size, then how it is shown at 1:1, at its own size or fitted. */
export function pictureHint(
  size: { width: number; height: number },
  shown: "one" | "own" | "fitted",
): string {
  const dims = pictureSize(size);
  if (shown === "one") return m.uiPictureViewerHintOne({ size: dims });
  if (shown === "own") return m.uiPictureViewerHintOwn({ size: dims });
  return m.uiPictureViewerHintFitted({ size: dims });
}
