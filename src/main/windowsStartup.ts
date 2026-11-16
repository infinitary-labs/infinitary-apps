import { APP_IDENTITIES, OWN_IDENTITY } from "@shared/codeNames";

/**
 * The identity Windows files the app's windows and notifications under
 * (docs/windows.md, "The installer"): the installer's Start menu entry
 * carries the app's id (`appId` in electron-builder.yml), so the installed
 * app sets the same one, and Windows shows its notifications as
 * Infinitary's. A run from source takes the development flavor's own, so
 * it never stands in for the installed app.
 */
export function windowsAppUserModelId(release: boolean): string {
  const id = APP_IDENTITIES[OWN_IDENTITY].bundleId;
  return release ? id : `${id}.dev`;
}
