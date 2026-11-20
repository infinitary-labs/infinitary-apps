/**
 * The Windows update check's test versions and where they read their
 * releases (docs/windows.md, "The update check"): windows.yml builds each
 * from the same commit with this release source, and the journey serves
 * that source on the clean machine (`updateFeed.ts`). Nothing here imports
 * the app, so `scripts/windows-update-source.ts` reads it as it is.
 */

/** Where the test versions' release source points: the clean machine's own feed. */
export const UPDATE_FEED_BASE = "https://localhost:8443/";
export const UPDATE_FEED_PORT = 8443;
/** The test versions' release page, which the builds file names and nothing opens. */
export const UPDATE_FEED_PAGE = `${UPDATE_FEED_BASE}releases/`;

/** The two test versions each channel's check updates between, oldest first. */
export const UPDATE_VERSIONS = {
  alpha: ["0.0.1-alpha.1", "0.0.1-alpha.2"],
  stable: ["0.0.1", "0.0.2"],
} as const;

/** The name electron-builder gives a version's installer (electron-builder.win.yml). */
export function installerName(version: string): string {
  return `Infinitary-${version}-windows-x64-setup.exe`;
}
