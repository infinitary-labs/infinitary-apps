import type { Session } from "electron";
import { isAppRendererSource, type RendererSourceOptions } from "./rendererSource";

/**
 * Only our renderer may capture microphone audio, write plain clipboard text
 * (Projects' sign-in code) or list the computer's installed fonts (the font
 * choice in Settings → Appearance, docs/fonts.md). Clipboard reads and
 * foreign documents stay denied. "media" covers getUserMedia; there is no
 * camera surface.
 */
export function isAllowedPermission(
  permission: string,
  requestingSource: string | undefined,
  options: RendererSourceOptions,
  dictationEnabled = true,
): boolean {
  return (
    ((permission === "media" && dictationEnabled) ||
      permission === "clipboard-sanitized-write" ||
      permission === "local-fonts") &&
    isAppRendererSource(requestingSource, options)
  );
}

export function configurePermissions(
  session: Session,
  options: RendererSourceOptions,
  dictationEnabled: () => boolean = () => true,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isAllowedPermission(permission, details.requestingUrl, options, dictationEnabled()));
  });
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const source = details.requestingUrl ?? requestingOrigin;
    return isAllowedPermission(permission, source, options, dictationEnabled());
  });
}
