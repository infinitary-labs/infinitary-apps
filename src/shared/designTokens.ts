/**
 * The design system's token scale, as data.
 *
 * The tokens themselves have one home: `src/renderer/src/design/tokens/*.css`
 * (the design skill owns the rules; the CSS is the implementation). Code that
 * has to REASON about a token - the personal-panel lint naming the nearest
 * token for a raw value - cannot read a stylesheet, so this table mirrors the
 * scale and `designTokens.test.ts` parses the CSS and fails the moment the two
 * drift. Nothing here is a second source of truth: it is the same numbers,
 * readable from Node.
 */

export type ColorToken = { readonly name: string; readonly dark: string; readonly light: string };
export type ScaleToken = { readonly name: string; readonly px: number };

/** Every color token that resolves to a literal color in both themes. */
export const COLOR_TOKENS: readonly ColorToken[] = [
  { name: "--bg-0", dark: "#05070d", light: "#eef1f7" },
  { name: "--material-tint", dark: "rgba(5, 7, 13, 1)", light: "rgba(238, 241, 247, 1)" },
  { name: "--bg-1", dark: "#0a0e18", light: "#f7f9fc" },
  { name: "--bg-2", dark: "#0f1424", light: "#ffffff" },
  { name: "--bg-3", dark: "#161c30", light: "#e7ecf5" },
  { name: "--line-1", dark: "rgba(150, 180, 255, 0.2)", light: "rgba(30, 50, 90, 0.18)" },
  { name: "--line-2", dark: "rgba(150, 180, 255, 0.24)", light: "rgba(30, 50, 90, 0.26)" },
  { name: "--fg-1", dark: "#e9eef8", light: "#151b2b" },
  { name: "--fg-2", dark: "#98a4bd", light: "#4d5a75" },
  { name: "--fg-3", dark: "#7a86a0", light: "#6c7891" },
  { name: "--accent", dark: "#7fdcff", light: "#0e8fd0" },
  { name: "--accent-strong", dark: "#38aae6", light: "#0a72a8" },
  { name: "--accent-dim", dark: "rgba(127, 220, 255, 0.14)", light: "rgba(14, 143, 208, 0.1)" },
  { name: "--accent-glow", dark: "rgba(127, 220, 255, 0.35)", light: "rgba(14, 143, 208, 0.25)" },
  { name: "--ok", dark: "#7fdcff", light: "#0e8fd0" },
  { name: "--ok-dim", dark: "rgba(127, 220, 255, 0.14)", light: "rgba(14, 143, 208, 0.1)" },
  { name: "--hot", dark: "#ffa257", light: "#d97a1f" },
  { name: "--hot-dim", dark: "rgba(255, 162, 87, 0.14)", light: "rgba(217, 122, 31, 0.12)" },
  { name: "--hot-glow", dark: "rgba(255, 148, 66, 0.35)", light: "rgba(217, 122, 31, 0.28)" },
  { name: "--warn", dark: "#ffa257", light: "#d97a1f" },
  { name: "--warn-dim", dark: "rgba(255, 162, 87, 0.14)", light: "rgba(217, 122, 31, 0.12)" },
  { name: "--danger", dark: "#ff6b52", light: "#cf4a2e" },
  { name: "--danger-dim", dark: "rgba(255, 107, 82, 0.12)", light: "rgba(207, 74, 46, 0.1)" },
  { name: "--captain", dark: "#b99aff", light: "#7254c9" },
  { name: "--captain-dim", dark: "rgba(185, 154, 255, 0.14)", light: "rgba(114, 84, 201, 0.12)" },
  { name: "--idle", dark: "#5d6884", light: "#8b96ad" },
  { name: "--slot-premium", dark: "#ff6b52", light: "#cf4a2e" },
  { name: "--slot-high", dark: "#ffa257", light: "#d97a1f" },
  { name: "--slot-medium", dark: "#7fdcff", light: "#0e8fd0" },
  { name: "--slot-low", dark: "#8a93a8", light: "#8b96ad" },
  { name: "--wire-accent", dark: "#7fdcff", light: "#0a72a8" },
  { name: "--wire-hot", dark: "#ffa257", light: "#e8760a" },
  { name: "--wire-dim", dark: "#2e6a8c", light: "#82b4cf" },
];

export const TEXT_SIZE_TOKENS: readonly ScaleToken[] = [
  { name: "--text-xs", px: 11 },
  { name: "--text-sm", px: 12.5 },
  { name: "--text-base", px: 14 },
  { name: "--text-md", px: 16 },
  { name: "--text-lg", px: 20 },
  { name: "--text-xl", px: 28 },
  { name: "--text-display", px: 44 },
];

export const SPACE_TOKENS: readonly ScaleToken[] = [
  { name: "--space-1", px: 4 },
  { name: "--space-2", px: 8 },
  { name: "--space-3", px: 12 },
  { name: "--space-4", px: 16 },
  { name: "--space-5", px: 24 },
  { name: "--space-6", px: 32 },
  { name: "--space-7", px: 48 },
  { name: "--space-8", px: 64 },
  { name: "--space-9", px: 96 },
];

export const RADIUS_TOKENS: readonly ScaleToken[] = [
  { name: "--radius-xs", px: 3 },
  { name: "--radius-s", px: 6 },
  { name: "--radius-m", px: 10 },
  { name: "--radius-l", px: 16 },
  { name: "--radius-pill", px: 999 },
];

/** The shadow scale, by the blur radius that separates its rungs. */
export const SHADOW_TOKENS: readonly ScaleToken[] = [
  { name: "--shadow-1", px: 2 },
  { name: "--shadow-2", px: 30 },
  { name: "--shadow-card", px: 40 },
];

/**
 * The accent family. "One accent per panel" counts these: a panel that lights
 * two different families is lighting two things at once (design skill, VISUAL
 * FOUNDATIONS). `--ok` is the same ice cyan as `--accent` but says state, so
 * it is counted with the state colors, not here.
 */
export const ACCENT_TOKENS: readonly string[] = [
  "--accent",
  "--accent-strong",
  "--accent-dim",
  "--accent-glow",
  "--hot",
  "--hot-dim",
  "--hot-glow",
  "--captain",
  "--captain-dim",
];

/** The accent family a token belongs to, for the one-accent count. */
export function accentFamilyOf(token: string): string | undefined {
  if (token.startsWith("--accent")) return "accent";
  if (token.startsWith("--hot")) return "hot";
  if (token.startsWith("--captain")) return "captain";
  return undefined;
}

type Rgb = { r: number; g: number; b: number };

/** `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(...)`, `rgba(...)` - else undefined. */
export function parseColor(value: string): Rgb | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex?.[1]) {
    const digits = hex[1];
    const expand = (part: string) => Number.parseInt(part.repeat(2 / part.length), 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0] as string),
        g: expand(digits[1] as string),
        b: expand(digits[2] as string),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
      };
    }
    return undefined;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!rgb?.[1]) return undefined;
  const parts = rgb[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return undefined;
  if ([r, g, b].some(Number.isNaN)) return undefined;
  return { r, g, b };
}

/**
 * The token whose color sits closest to a raw one, in either theme. Plain
 * RGB distance: the lint only has to name a candidate the author recognises,
 * never to prove a perceptual match.
 */
export function nearestColorToken(value: string): string | undefined {
  const target = parseColor(value);
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const token of COLOR_TOKENS) {
    for (const themed of [token.dark, token.light]) {
      const candidate = parseColor(themed);
      if (!candidate) continue;
      const distance =
        (candidate.r - target.r) ** 2 +
        (candidate.g - target.g) ** 2 +
        (candidate.b - target.b) ** 2;
      if (!best || distance < best.distance) best = { name: token.name, distance };
    }
  }
  return best?.name;
}

function nearestOnScale(scale: readonly ScaleToken[], px: number): string {
  let best = scale[0] as ScaleToken;
  for (const token of scale) {
    if (Math.abs(token.px - px) < Math.abs(best.px - px)) best = token;
  }
  return best.name;
}

export function nearestTextSizeToken(px: number): string {
  return nearestOnScale(TEXT_SIZE_TOKENS, px);
}

export function nearestRadiusToken(px: number): string {
  return nearestOnScale(RADIUS_TOKENS, px);
}

export function nearestSpaceToken(px: number): string {
  return nearestOnScale(SPACE_TOKENS, px);
}

/** A raw box-shadow's nearest rung, keyed on its largest blur radius. */
export function nearestShadowToken(value: string): string {
  const blurs = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  const blur = blurs.length > 0 ? Math.max(...blurs.map(Math.abs)) : 0;
  return nearestOnScale(SHADOW_TOKENS, blur);
}

/** Is this radius one the scale already names? */
export function isRadiusOnScale(px: number): boolean {
  return RADIUS_TOKENS.some((token) => token.px === px);
}
