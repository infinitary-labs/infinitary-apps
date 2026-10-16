/**
 * Where a style sheet's `@font-face` rules name their fonts
 * (docs/card-authoring.md, "Fonts by reference"): every `url()` inside an
 * `@font-face` block, with the range of the whole token and the value it
 * names, so the host can rewrite exactly that token and leave every other
 * byte of the sheet as written. A `url()` anywhere else - a background, an
 * `@import` - is not a font and is never read here.
 *
 * It reads CSS only as far as that takes: comments and strings are skipped,
 * so a brace or `url(` inside either changes nothing, and a block's end is
 * its matching brace. What the browser makes of the rest of the sheet is
 * the browser's business; the frame loads nothing the host did not rewrite.
 */

/** One `url()` an `@font-face` names: the token's range in the sheet, and its value. */
export type FontFaceUrl = { start: number; end: number; value: string };

/** The index just past a string that opens at `at`, or the sheet's end when it never closes. */
function stringEnd(css: string, at: number): number {
  const quote = css[at];
  let i = at + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, css.length);
}

/** The index just past a comment that opens at `at`, or the sheet's end when it never closes. */
function commentEnd(css: string, at: number): number {
  const end = css.indexOf("*/", at + 2);
  return end === -1 ? css.length : end + 2;
}

/** The `url()` token that opens at `at`, or undefined when it is not one. */
function urlToken(css: string, at: number): FontFaceUrl | undefined {
  let i = at + 4;
  while (/\s/.test(css[i] ?? "")) i++;
  let value: string;
  if (css[i] === '"' || css[i] === "'") {
    const end = stringEnd(css, i);
    value = css.slice(i + 1, end - 1);
    i = end;
    while (/\s/.test(css[i] ?? "")) i++;
  } else {
    const start = i;
    while (i < css.length && !/[\s)]/.test(css[i] as string)) i++;
    value = css.slice(start, i);
    while (/\s/.test(css[i] ?? "")) i++;
  }
  if (css[i] !== ")") return undefined;
  return { start: at, end: i + 1, value };
}

/** Every `url()` inside the block whose opening brace is at `open`, and the index past its closing brace. */
function blockUrls(css: string, open: number): { urls: FontFaceUrl[]; end: number } {
  const urls: FontFaceUrl[] = [];
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const char = css[i];
    if (char === '"' || char === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (char === "/" && css[i + 1] === "*") {
      i = commentEnd(css, i);
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return { urls, end: i + 1 };
    if (/^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? "")) {
      const token = urlToken(css, i);
      if (token) {
        urls.push(token);
        i = token.end;
        continue;
      }
    }
    i++;
  }
  return { urls, end: css.length };
}

/** Every `url()` the sheet's `@font-face` rules name, in order. */
export function fontFaceUrls(css: string): FontFaceUrl[] {
  const found: FontFaceUrl[] = [];
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === '"' || char === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (char === "/" && css[i + 1] === "*") {
      i = commentEnd(css, i);
      continue;
    }
    if (char === "@" && /^@font-face\b/i.test(css.slice(i, i + 11))) {
      let open = i + 10;
      while (open < css.length && css[open] !== "{" && css[open] !== ";") open++;
      if (css[open] !== "{") {
        i = open;
        continue;
      }
      const block = blockUrls(css, open);
      found.push(...block.urls);
      i = block.end;
      continue;
    }
    i++;
  }
  return found;
}
