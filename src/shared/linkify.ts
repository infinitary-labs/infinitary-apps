/**
 * Split a plain-text card body into surrounding text and http(s) URLs so
 * the renderer can linkify without touching live-prototype HTML.
 */

export type CardBodyPart = { type: "text"; value: string } | { type: "url"; value: string };

// Scheme-anchored: javascript:, file:, and friends never match.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

function unmatchedCloser(value: string, open: string, close: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === open) depth += 1;
    else if (char === close) depth -= 1;
  }
  return depth < 0;
}

export function trimTrailingUrlPunctuation(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = "";
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!last) break;
    const strip =
      /[.,;:!?']/.test(last) ||
      (last === ")" && unmatchedCloser(url, "(", ")")) ||
      (last === "]" && unmatchedCloser(url, "[", "]")) ||
      (last === "}" && unmatchedCloser(url, "{", "}"));
    if (!strip) break;
    url = url.slice(0, -1);
    trailing = last + trailing;
  }
  return { url, trailing };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Card-link allowlist shared by the markdown renderer and main's
 * open-external gate: any https, plus http loopback and genuine
 * dot-delimited `.localhost` subdomains. javascript:, file:, and other
 * schemes stay closed.
 */
export function isSafeCardHref(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      const host = url.hostname.toLowerCase();
      return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function splitCardBodyUrls(body: string): CardBodyPart[] {
  const parts: CardBodyPart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const { url } = trimTrailingUrlPunctuation(match[0]);
    if (!url || !isHttpUrl(url)) continue;
    if (start > cursor) {
      parts.push({ type: "text", value: body.slice(cursor, start) });
    }
    parts.push({ type: "url", value: url });
    cursor = start + url.length;
  }
  if (cursor < body.length) {
    parts.push({ type: "text", value: body.slice(cursor) });
  }
  return parts;
}
