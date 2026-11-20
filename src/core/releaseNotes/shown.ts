import {
  type ReleaseNotesView,
  type ReleaseTrackingRecord,
  versionName,
} from "@shared/releaseTracking";

/**
 * The release notes the app showed, newest first, from the version
 * tracking record (docs/release-notes.md "Reading a note again"): each
 * delivery that made a card, which What's new and Settings open again as it
 * was shown. Nothing here writes.
 */
export function releaseNotesView(
  tracking: ReleaseTrackingRecord,
  version: string,
): ReleaseNotesView {
  const notes = Object.entries(tracking.deliveries)
    .flatMap(([noteVersion, delivery]) =>
      delivery.cardId
        ? [
            {
              version: noteVersion,
              name: versionName(noteVersion),
              cardId: delivery.cardId,
              listed: delivery.entryIds.length > 0,
              shownAt: delivery.deliveredAt,
            },
          ]
        : [],
    )
    .sort((a, b) => b.shownAt - a.shownAt);
  return { version, name: versionName(version), notes };
}
