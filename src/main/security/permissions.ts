import type { Session } from "electron";
import { isAppRendererSource, type RendererSourceOptions } from "./rendererSource";

/**
 * Only our renderer may capture microphone audio or write plain clipboard text
 * (Projects' sign-in code). Clipboard reads and foreign documents stay denied.
 * "media" covers getUserMedia; there is no camera surface.
 */
export function isAllowedPermission(
  permission: string,
  requestingSource: string | undefined,
  options: RendererSourceOptions,
  dictationEnabled = true,
): boolean {
  return (
    ((permission === "media" && dictationEnabled) || permission === "clipboard-sanitized-write") &&
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
