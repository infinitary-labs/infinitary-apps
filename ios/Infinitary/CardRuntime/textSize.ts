import typographyCss from "../../../src/renderer/src/design/tokens/typography.css?raw";

/**
 * The phone's Text Size on its cards and panels (docs/ios.md, "Text size"): every type size the Mac's stylesheet draws
 * a card or panel at, times one factor the phone hands its page, the device's body size over the Mac's 14. Inside a
 * drawing the sizes stay the Mac's, so a label never grows into its neighbour. The rule follows the Mac's own tokens and
 * only ever rides a phone page; the Mac's stylesheet is untouched. It also tells WebKit to leave the text's size alone
 * (`text-size-adjust: 100%`): left to itself, iOS enlarges a wide card's words, so the same line drew at 19 points in a
 * wide card and 17 in a narrow one (INF-4838).
 */

/** The custom property the factor sits in: the rule's own value at mount, then the frame's `text-scale` message. */
export const TEXT_SCALE_PROPERTY = "--inf-text-scale";

/** Each `--text-*` size token the Mac's typography sets, in pixels, read from its own file. */
export function typeSizes(css: string = typographyCss): [name: string, px: number][] {
  return [...css.matchAll(/(--text-[a-z]+)\s*:\s*([\d.]+)px/g)].map((match) => [String(match[1]), Number(match[2])]);
}

/** A factor the page may draw at: a positive finite number, or the Mac's own size. */
export function textScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

/** The rule that follows the card or panel stylesheet on the phone, starting at `scale`. */
export function phoneTextRule(scale: number): string {
  const sizes = typeSizes();
  const scaled = sizes.map(([name, px]) => `${name}: calc(${px}px * var(${TEXT_SCALE_PROPERTY}));`).join(" ");
  const pinned = sizes.map(([name, px]) => `${name}: ${px}px;`).join(" ");
  return `\n:root { ${TEXT_SCALE_PROPERTY}: ${textScale(scale)}; ${scaled} -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }\nsvg { ${pinned} }\n`;
}
