// Joins a paragraph's sentence lines the way its language does (docs/docs-site.md,
// "Translated pages"). Pages are written one sentence per line, and a browser draws each
// line break inside a paragraph as a space. Chinese and Japanese put no space between
// sentences, or after full-width punctuation such as 。 or 」, so the site drops such a
// line break instead of leaving it for the browser. Korean puts spaces between words, and
// every other language keeps its space too.

// Chinese and Japanese characters, kana and full-width forms: the characters a browser sets
// full width (East Asian Width wide, full width or half width), Korean left out.
const WIDE =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Bopomofo}⺀-⿿　-〿぀-ヿ㆐-ㇿ㈀-㏿︐-︟︰-﹏！-ﾟ￠-￦]/u;
const HANGUL = /\p{sc=Hangul}/u;
const PUNCTUATION = /\p{P}/u;
// Quotation marks, dashes and ellipses, which Chinese and Japanese text shares with Latin text.
const SHARED_PUNCTUATION = /[‐-‧‰-⁞]/u;
// A line break with the spaces or tabs on either side of it.
const LINE_BREAK = /[ \t]*\n[ \t]*/g;
// What stands in for a piece of a paragraph that is not text, such as a picture.
const OBJECT = "￼";

/** The kind of one character, for deciding whether a line break beside it is a space. */
function kindOf(char) {
  if (HANGUL.test(char)) return "hangul";
  if (WIDE.test(char)) return PUNCTUATION.test(char) ? "wide-punctuation" : "wide";
  if (SHARED_PUNCTUATION.test(char) && PUNCTUATION.test(char)) return "shared-punctuation";
  return "other";
}

const isWide = (kind) => kind === "wide" || kind === "wide-punctuation";

/** The character ending just before index in text, or undefined at its start. */
function charBefore(text, index) {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const pair = index >= 2 && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(pair ? index - 2 : index - 1, index);
}

/** The character starting at index in text, or undefined at its end. */
function charAt(text, index) {
  const point = text.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

/**
 * The kind of the character beside a line break, on one side of it: step is -1 for the
 * character before, 1 for the one after. A quotation mark or dash that sits against
 * Chinese or Japanese on its far side, such as ” closing 看不到。”, counts as full-width
 * punctuation, as a Chinese or Japanese typeface draws it.
 */
function kindBeside(text, index, step) {
  const next = (at) => {
    const char = step < 0 ? charBefore(text, at) : charAt(text, at);
    return char === undefined ? undefined : { char, at: step < 0 ? at - char.length : at + char.length };
  };
  const first = next(index);
  if (!first) return "other";
  const kind = kindOf(first.char);
  if (kind !== "shared-punctuation") return kind;
  for (let found = next(first.at); found; found = next(found.at)) {
    const beyond = kindOf(found.char);
    if (beyond === "shared-punctuation") continue;
    return isWide(beyond) ? "wide-punctuation" : kind;
  }
  return kind;
}

/** Whether a line break between characters of these kinds draws nothing, rather than a space. */
function joins(before, after) {
  if (before === "hangul" || after === "hangul") return false;
  if (before === "wide-punctuation" || after === "wide-punctuation") return true;
  if (isWide(before) && isWide(after)) return true;
  return (before === "shared-punctuation" && isWide(after)) || (after === "shared-punctuation" && isWide(before));
}

/**
 * A paragraph's pieces in order, its line breaks between Chinese or Japanese sentences
 * dropped. Each piece is a string of the paragraph's text, or { fixed } for one that keeps
 * its words, such as inline code, which still counts as the characters beside a break.
 * Returns each piece's text, the fixed ones as given.
 */
export function joinSentenceLines(pieces) {
  const texts = pieces.map((piece) => (typeof piece === "string" ? piece : piece.fixed));
  const whole = texts.join("");
  let offset = 0;
  return pieces.map((piece, index) => {
    const start = offset;
    offset += texts[index].length;
    if (typeof piece !== "string") return piece.fixed;
    return piece.replace(LINE_BREAK, (lineBreak, at) => {
      const before = kindBeside(whole, start + at, -1);
      const after = kindBeside(whole, start + at + lineBreak.length, 1);
      return joins(before, after) ? "" : lineBreak;
    });
  });
}

/** Every piece of phrasing content under node, in order, as joinSentenceLines takes them. */
function piecesOf(node, pieces = []) {
  for (const child of node.children ?? []) {
    if (child.type === "text") pieces.push({ node: child, piece: child.value });
    else if (child.type === "inlineCode") pieces.push({ piece: { fixed: child.value } });
    // Raw HTML in a sentence, such as <kbd>, wraps words without being one.
    else if (child.type === "html") continue;
    else if ("children" in child) piecesOf(child, pieces);
    else pieces.push({ piece: { fixed: OBJECT } });
  }
  return pieces;
}

/** Drops each line break in node's text that joinSentenceLines drops. */
function joinNode(node, ctx) {
  const pieces = piecesOf(node);
  if (!pieces.some(({ node: text }) => text?.value.includes("\n"))) return;
  const joined = joinSentenceLines(pieces.map(({ piece }) => piece));
  pieces.forEach(({ node: text }, index) => {
    if (text && joined[index] !== text.value) ctx.setField(text, "value", joined[index]);
  });
}

/** The Markdown step, for the site's Markdown processor's mdastPlugins. */
export const sentenceLines = {
  name: "infinitary-sentence-lines",
  paragraph: joinNode,
  heading: joinNode,
};
