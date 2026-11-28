/**
 * What counts as an address in a card's words, and which addresses a card
 * may open. A plain-text body and a thread message on the computer are split here
 * (`splitCardBodyUrls`); the card frame's
 * bridge links the addresses an HTML body writes as words
 * (src/shared/plugins/frameLinkScript.ts), and the phone links a reply's
 * (PhoneLinkedWords.swift in the phone's kit). Only the data below is spliced
 * into the bridge's text and generated into the phone's contract; each keeps
 * its own twins of the trimming and opener logic (the bridge's `addressIn`,
 * `unmatched` and `opens`; the phone's `PhoneLinkedWords`), which a change to
 * `trimTrailingUrlPunctuation` or `isSafeCardHref` must mirror. The phone's
 * kit tests read this file's own split of the same replies.
 */

export type CardBodyPart = { type: "text"; value: string } | { type: "url"; value: string };

/**
 * An address in words, as a case-blind pattern: scheme-anchored, so javascript:, file: and friends never match.
 * It ends at the CJK symbols and punctuation block and at full-width punctuation (not full-width letters or
 * digits), which Chinese and Japanese words write right after an address with no space between.
 */
export const URL_IN_TEXT =
  "https?:\\/\\/[^\\s<>\"'`\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]+";
const URL_RE = new RegExp(URL_IN_TEXT, "gi");

/** Punctuation that ends a sentence around an address rather than the address itself. */
export const URL_TRAILING_PUNCTUATION = ".,;:!?'";
/** Each closing bracket an address keeps only when the address opened it: "(see https://x.dev/a)". */
export const URL_CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
/** The hosts plain http may reach from a card: this computer, and genuine `.localhost` names under `LOCALHOST_SUFFIX`. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const LOCALHOST_SUFFIX = ".localhost";

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
    const opener = URL_CLOSERS[last];
    const strip =
      URL_TRAILING_PUNCTUATION.includes(last) ||
      (opener !== undefined && unmatchedCloser(url, opener, last));
    if (!strip) break;
    url = url.slice(0, -1);
    trailing = last + trailing;
  }
  return { url, trailing };
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
      return LOOPBACK_HOSTS.includes(host) || host.endsWith(LOCALHOST_SUFFIX);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * A card's words split at the addresses they write: only an address the safe
 * opener takes is a part of its own, so a link never stands where a press
 * would open nothing. A plain-text body and a thread message use it, and the
 * phone's kit tests replay its split.
 */
export function splitCardBodyUrls(body: string): CardBodyPart[] {
  const parts: CardBodyPart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const { url } = trimTrailingUrlPunctuation(match[0]);
    if (!url || !isSafeCardHref(url)) continue;
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
