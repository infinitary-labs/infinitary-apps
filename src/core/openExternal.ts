import { isSafeCardHref } from "@shared/linkify";

/**
 * Allowlist for renderer-initiated shell.openExternal (card links, auth).
 * Broader than the window-open github host list: any https, plus http
 * loopback. javascript:, file:, and other schemes stay closed.
 */
export function isAllowedOpenExternalUrl(value: string): boolean {
  return isSafeCardHref(value);
}
