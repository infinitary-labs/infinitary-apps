// Color themes (docs/themes.md): a theme is at most six colors, and the app
// works out every color token from them, holding each readability floor by
// moving lightness only. Dark and Light are not themes here: they keep their
// hand-tuned values in src/renderer/src/design/tokens/colors.css, and every
// theme sits on one of them, its base.

import { z } from "zod";
import { COLOR_TOKENS } from "./designTokens";

/** Dark or Light, as preferences.ts names them; typed here so the look can import this module. */
type Theme = "dark" | "light";

/** The six colors a theme is made of, each `#rrggbb`. */
export type ThemeSeed = {
  /** The window's own color; every surface steps from it in its hue. */
  readonly background: string;
  readonly text: string;
  /** Calm: done, links, the first mate's light. */
  readonly accent: string;
  /** Working and attention. */
  readonly hot: string;
  /** Errors. */
  readonly danger: string;
  /** The person's own activity. */
  readonly captain: string;
};

export type BuiltInTheme = {
  /** Its maker's name, shown untranslated: the captain chose makers' names for all. */
  readonly name: string;
  /** The published theme its six colors come from, as NOTICE credits it. */
  readonly source: string;
  readonly seed: ThemeSeed;
};

/**
 * The built-in themes, in the order Settings lists them. Every color is a
 * value its source theme's own file uses; which six, and the job each does
 * here, are this table's. Rosé Pine's calm color is its foam: its rose and
 * iris sit too close to its gold and love for the distance checks below.
 */
// i18n-exempt: makers' names and their published themes' names, shown untranslated
export const BUILT_IN_THEMES = {
  "rose-pine": {
    name: "Rosé Pine",
    source: "Rosé Pine",
    seed: {
      background: "#191724",
      text: "#e0def4",
      accent: "#9ccfd8",
      hot: "#f6c177",
      danger: "#eb6f92",
      captain: "#c4a7e7",
    },
  },
  "rose-pine-moon": {
    name: "Rosé Pine Moon",
    source: "Rosé Pine",
    seed: {
      background: "#232136",
      text: "#e0def4",
      accent: "#9ccfd8",
      hot: "#f6c177",
      danger: "#eb6f92",
      captain: "#c4a7e7",
    },
  },
  "rose-pine-dawn": {
    name: "Rosé Pine Dawn",
    source: "Rosé Pine",
    seed: {
      background: "#faf4ed",
      text: "#575279",
      accent: "#56949f",
      hot: "#ea9d34",
      danger: "#b4637a",
      captain: "#907aa9",
    },
  },
  "catppuccin-latte": {
    name: "Catppuccin Latte",
    source: "Catppuccin for VSCode",
    seed: {
      background: "#eff1f5",
      text: "#4c4f69",
      accent: "#8839ef",
      hot: "#fe640b",
      danger: "#d20f39",
      captain: "#1e66f5",
    },
  },
  "catppuccin-frappe": {
    name: "Catppuccin Frappé",
    source: "Catppuccin for VSCode",
    seed: {
      background: "#303446",
      text: "#c6d0f5",
      accent: "#ca9ee6",
      hot: "#ef9f76",
      danger: "#e78284",
      captain: "#8caaee",
    },
  },
  "catppuccin-macchiato": {
    name: "Catppuccin Macchiato",
    source: "Catppuccin for VSCode",
    seed: {
      background: "#24273a",
      text: "#cad3f5",
      accent: "#c6a0f6",
      hot: "#f5a97f",
      danger: "#ed8796",
      captain: "#8aadf4",
    },
  },
  "catppuccin-mocha": {
    name: "Catppuccin Mocha",
    source: "Catppuccin for VSCode",
    seed: {
      background: "#1e1e2e",
      text: "#cdd6f4",
      accent: "#cba6f7",
      hot: "#fab387",
      danger: "#f38ba8",
      captain: "#89b4fa",
    },
  },
  "one-dark": {
    name: "One Dark",
    source: "One Dark Pro",
    seed: {
      background: "#282c34",
      text: "#abb2bf",
      accent: "#61afef",
      hot: "#d19a66",
      danger: "#e06c75",
      captain: "#c678dd",
    },
  },
  "one-light": {
    name: "One Light",
    source: "Atom One Light Theme",
    seed: {
      background: "#eaeaeb",
      text: "#383a42",
      accent: "#4078f2",
      hot: "#c18401",
      danger: "#e45649",
      captain: "#a626a4",
    },
  },
  dracula: {
    name: "Dracula",
    source: "Dracula Theme Official",
    seed: {
      background: "#282a36",
      text: "#f8f8f2",
      accent: "#bd93f9",
      hot: "#ffb86c",
      danger: "#ff5555",
      captain: "#ff79c6",
    },
  },
  "night-owl": {
    name: "Night Owl",
    source: "Night Owl",
    seed: {
      background: "#011627",
      text: "#d6deeb",
      accent: "#82aaff",
      hot: "#ffcb8b",
      danger: "#ef5350",
      captain: "#c792ea",
    },
  },
  "night-owl-light": {
    name: "Night Owl Light",
    source: "Night Owl",
    seed: {
      background: "#f0f0f0",
      text: "#403f53",
      accent: "#2aa298",
      hot: "#daaa01",
      danger: "#de3d3b",
      captain: "#994cc3",
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    source: "Tokyo Night",
    seed: {
      background: "#1a1b26",
      text: "#c0caf5",
      accent: "#7aa2f7",
      hot: "#e0af68",
      danger: "#f7768e",
      captain: "#bb9af7",
    },
  },
} as const satisfies Record<string, BuiltInTheme>;

export type BuiltInThemeId = keyof typeof BUILT_IN_THEMES;
export const BUILT_IN_THEME_IDS = Object.keys(BUILT_IN_THEMES) as BuiltInThemeId[];

export function isBuiltInTheme(id: string | undefined | null): id is BuiltInThemeId {
  return typeof id === "string" && Object.hasOwn(BUILT_IN_THEMES, id);
}

/**
 * A saved theme's name: any short name, so a theme a newer build saved still
 * reads here, where the window shows its base.
 */
export const colorThemeSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9-]+$/);

/** What the app holds each color to, in WCAG contrast. */
export const FLOORS = {
  text: 7,
  quietText: 4.5,
  faintText: 3,
  /** Accent, hot, danger and captain, on the card surface. */
  state: 3,
  onAccent: 4.5,
} as const;

/** The least OKLab distance between state colors a person must tell apart. */
export const APART = { accentHot: 0.12, accentDanger: 0.12, hotDanger: 0.06 } as const;

/** The body attribute naming the color theme a window draws, which a still drawing watches beside `data-theme`. */
export const COLOR_THEME_ATTRIBUTE = "data-color-theme";

/** The id of the window's sheet that lays its color theme, and the attribute on it naming the base it was laid on. */
export const COLOR_THEME_SHEET = { id: "inf-color-theme", base: "data-base" } as const;

/** Words on accent-filled controls in Dark and Light, as colors.css has them. */
export const SHIPPED_ON_ACCENT = "#05070d";

// --- color math: sRGB, OKLab and OKLCH, WCAG contrast ---

type Rgb = [number, number, number];
type Lch = { L: number; C: number; H: number };

const hexToRgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
};
const rgbToHex = (rgb: Rgb): string =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToOklab([r0, g0, b0]: Rgb): Rgb {
  const r = linear(r0);
  const g = linear(g0);
  const b = linear(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function toLch(hex: string): Lch {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(a, b), H: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** A color at this lightness, chroma and hue, its chroma lowered until the screen can show it. */
function fromLch({ L: given, C, H }: Lch): string {
  const L = Math.min(1, Math.max(0, given));
  const at = (c: number) =>
    oklabToRgb([L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180)]);
  if (inGamut(at(C))) return rgbToHex(at(C));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid;
    else hi = mid;
  }
  return rgbToHex(at(lo));
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of two `#rrggbb` colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** OKLab distance of two `#rrggbb` colors; about 0.02 is the least a careful eye sees. */
export function colorDistance(a: string, b: string): number {
  const p = rgbToOklab(hexToRgb(a));
  const q = rgbToOklab(hexToRgb(b));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Moves a color's lightness away from its ground until it clears the floor,
 * keeping hue and as much chroma as the screen shows; no further than needed.
 */
function lift(color: string, ground: string, floor: number, dark: boolean) {
  if (contrast(color, ground) >= floor) return { color, moved: 0 };
  const c = toLch(color);
  let lo = c.L;
  let hi = dark ? 1 : 0;
  let out = color;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const tried = fromLch({ ...c, L: mid });
    if (contrast(tried, ground) >= floor) {
      hi = mid;
      out = tried;
    } else lo = mid;
  }
  return { color: out, moved: Math.abs(toLch(out).L - c.L) };
}

export type WorkedOutTheme = {
  /** Dark or Light: whatever knows only those two follows this. */
  base: Theme;
  /** Every color token, `--on-accent` included. */
  tokens: Record<string, string>;
  /** The colors the app moved to reach a floor, in words. */
  moved: string[];
  /** What no move can repair; a theme with any is never applied. */
  faults: string[];
};

/** Works out every color token from a theme's six colors. */
export function workOutTheme(seed: ThemeSeed): WorkedOutTheme {
  const moved: string[] = [];
  const faults: string[] = [];
  const bg = toLch(seed.background);
  const dark = bg.L < 0.6;
  // A grey window takes its hue from the accent, so its surfaces are not tinted at random.
  const hue = bg.C < 0.004 ? toLch(seed.accent).H : bg.H;
  // The surfaces step as Dark and Light step, in the background's own hue.
  const step = dark ? [0, 0.036, 0.066, 0.102] : [0, 0.023, 0.042, -0.016];
  const chroma = dark ? [1, 1.45, 2.1, 2.6] : [1, 0.6, 0.15, 1.4];
  // A near-black window still gets cards a person can tell from it.
  const least = dark ? [0, 0.125, 0.16, 0.195] : [0, 0, 0, 0];
  // Raised surfaces never grow more vivid than 0.06 or the background itself.
  const cap = Math.max(0.06, bg.C);
  const [bg0, bg1, bg2, bg3] = step.map((d, i) =>
    i === 0
      ? seed.background.toLowerCase()
      : fromLch({
          L: Math.min(1, Math.max(bg.L + d, least[i] as number)),
          C: Math.min(cap, bg.C * (chroma[i] as number)),
          H: hue,
        }),
  ) as [string, string, string, string];
  // Text reads worst on the brightest dark surface, or on a light window itself.
  const worst = dark ? bg3 : bg0;
  const text = toLch(seed.text);
  const textHue = text.C < 0.004 ? hue : text.H;
  const hold = (name: string, color: string, floor: number, ground = worst) => {
    const r = lift(color, ground, floor, dark);
    // i18n-exempt: a theme author's report, read in tests and docs, never in the window
    if (r.moved > 0.004) moved.push(`${name} ${color} → ${r.color} to reach ${floor}:1`);
    return r.color;
  };
  const fg1 = hold("text", seed.text, FLOORS.text);
  const fg2 = hold(
    // i18n-exempt: a theme author's report, never in the window
    "quiet text",
    fromLch({
      L: dark ? text.L - 0.23 : text.L + 0.243,
      C: Math.max(text.C, 0.035),
      H: textHue,
    }),
    FLOORS.quietText,
  );
  const fg3 = hold(
    // i18n-exempt: a theme author's report, never in the window
    "faint text",
    fromLch({
      L: dark ? text.L - 0.328 : text.L + 0.348,
      C: Math.max(text.C, 0.035),
      H: textHue,
    }),
    FLOORS.faintText,
  );
  // State colors are held on the card surface, where words and marks in them sit.
  const accent = hold("accent", seed.accent, FLOORS.state, bg2);
  const hot = hold("hot", seed.hot, FLOORS.state, bg2);
  const danger = hold("danger", seed.danger, FLOORS.state, bg2);
  const captain = hold("captain", seed.captain, FLOORS.state, bg2);
  const a = toLch(accent);
  const accentStrong = fromLch({
    L: a.L - (dark ? 0.148 : 0.093),
    C: a.C * (dark ? 1.3 : 0.86),
    H: a.H + (dark ? 8 : 0),
  });
  // The window's own color on a dark theme's accent, else whichever of white and the void reads best.
  const onAccent =
    dark && contrast(bg0, accent) >= contrast("#ffffff", accent)
      ? bg0
      : contrast("#ffffff", accent) >= contrast(SHIPPED_ON_ACCENT, accent)
        ? "#ffffff"
        : SHIPPED_ON_ACCENT;
  // i18n-exempt: a theme author's report, never in the window
  if (contrast(onAccent, accent) < FLOORS.onAccent)
    moved.push(`button words on accent reach only ${contrast(onAccent, accent).toFixed(1)}:1`);
  const line = fromLch(dark ? { L: 0.777, C: 0.113, H: hue } : { L: 0.323, C: 0.076, H: hue });
  const idle = fromLch({ L: dark ? 0.519 : 0.672, C: 0.04, H: hue });
  const slotLow = fromLch({ L: dark ? 0.663 : 0.672, C: 0.034, H: hue });
  const wireDim = fromLch({ L: dark ? 0.5 : 0.744, C: a.C * (dark ? 0.8 : 0.5), H: a.H });
  // i18n-exempt: a theme author's report, never in the window
  if (colorDistance(accent, hot) < APART.accentHot)
    faults.push(
      `hot ${hot} is too close to accent ${accent}: a working crewmate would look like an idle one. Give hot a hue well away from accent.`,
    );
  // i18n-exempt: a theme author's report, never in the window
  if (colorDistance(accent, danger) < APART.accentDanger)
    faults.push(
      `danger ${danger} is too close to accent ${accent}: an error would look like a link. Give danger a hue well away from accent.`,
    );
  // i18n-exempt: a theme author's report, never in the window
  if (colorDistance(hot, danger) < APART.hotDanger)
    faults.push(
      `danger ${danger} is too close to hot ${hot}: an error would look like work in progress.`,
    );
  // i18n-exempt: a theme author's report, never in the window
  if (contrast(fg1, bg0) < FLOORS.text)
    faults.push(
      `text cannot reach ${FLOORS.text}:1 on background ${seed.background}: make the background darker or lighter.`,
    );
  const dim = dark ? 0.14 : 0.1;
  const tokens: Record<string, string> = {
    "--bg-0": bg0,
    "--material-tint": rgba(bg0, 1),
    "--bg-1": bg1,
    "--bg-2": bg2,
    "--bg-3": bg3,
    "--line-1": rgba(line, dark ? 0.2 : 0.18),
    "--line-2": rgba(line, dark ? 0.24 : 0.26),
    "--fg-1": fg1,
    "--fg-2": fg2,
    "--fg-3": fg3,
    "--accent": accent,
    "--accent-strong": accentStrong,
    "--accent-dim": rgba(accent, dim),
    "--accent-glow": rgba(accent, dark ? 0.35 : 0.25),
    "--ok": accent,
    "--ok-dim": rgba(accent, dim),
    "--hot": hot,
    "--hot-dim": rgba(hot, dark ? 0.14 : 0.12),
    "--hot-glow": rgba(hot, dark ? 0.35 : 0.28),
    "--warn": hot,
    "--warn-dim": rgba(hot, dark ? 0.14 : 0.12),
    "--danger": danger,
    "--danger-dim": rgba(danger, dark ? 0.12 : 0.1),
    "--captain": captain,
    "--captain-dim": rgba(captain, dark ? 0.14 : 0.12),
    "--idle": idle,
    "--slot-premium": danger,
    "--slot-high": hot,
    "--slot-medium": accent,
    "--slot-low": slotLow,
    "--wire-accent": dark ? accent : accentStrong,
    "--wire-hot": hot,
    "--wire-dim": wireDim,
    "--on-accent": onAccent,
  };
  return { base: dark ? "dark" : "light", tokens, moved, faults };
}

const worked = new Map<BuiltInThemeId, WorkedOutTheme>();

/** A built-in theme, worked out once. */
export function builtInTheme(id: BuiltInThemeId): WorkedOutTheme {
  let theme = worked.get(id);
  if (!theme) {
    theme = workOutTheme(BUILT_IN_THEMES[id].seed);
    worked.set(id, theme);
  }
  return theme;
}

/** Dark or Light, as a theme's background decides it: Light at 0.6 OKLab lightness or more. */
export function themeBase(background: string): Theme {
  return toLch(background).L < 0.6 ? "dark" : "light";
}

/**
 * Words for a theme given no text color: near white or near black in the
 * background's hue, or the accent's on a grey background, as Dark's and
 * Light's own words sit.
 */
export function textFor(background: string, accent: string): string {
  const bg = toLch(background);
  const dark = bg.L < 0.6;
  return fromLch({
    L: dark ? 0.948 : 0.224,
    C: dark ? 0.014 : 0.033,
    H: bg.C < 0.004 ? toLch(accent).H : bg.H,
  });
}

/** A person's own theme as drawing needs it: its id and six colors (src/shared/ownColorThemes.ts). */
export type OwnThemeColors = { readonly id: string; readonly colors: ThemeSeed };

// Keyed on the saved colors themselves, so a theme saved again under its name is worked out anew.
const ownWorked = new WeakMap<ThemeSeed, WorkedOutTheme>();

/** The theme a saved name names, built-in or one of the person's own, worked out; null for a name neither has. */
export function themeOf(
  saved: string | undefined | null,
  own: readonly OwnThemeColors[] = [],
): WorkedOutTheme | null {
  if (isBuiltInTheme(saved)) return builtInTheme(saved);
  const mine = own.find((theme) => theme.id === saved);
  if (!mine) return null;
  let theme = ownWorked.get(mine.colors);
  if (!theme) {
    theme = workOutTheme(mine.colors);
    ownWorked.set(mine.colors, theme);
  }
  return theme;
}

/**
 * The theme a saved name draws on a base: a built-in or own one sitting on
 * that base, or none for a name this build lacks or a look drawn in the
 * other base, such as a picture of each.
 */
export function shownTheme(
  saved: string | undefined | null,
  base: Theme,
  own: readonly OwnThemeColors[] = [],
): string | null {
  return themeOf(saved, own)?.base === base ? (saved as string) : null;
}

/** Dark's or Light's own color tokens, as colors.css has them, `--on-accent` included. */
export function shippedTokens(base: Theme): Record<string, string> {
  return Object.fromEntries(COLOR_TOKENS.map((token) => [token.name, token[base]]));
}

/**
 * The one rule that lays a theme's tokens over the color sheets: on `:root`
 * and on every `data-theme` scope, since colors.css declares Light's on the
 * body. Its sheet must come after colors.css.
 */
export function themeRule(tokens: Record<string, string>): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  return `:root, [data-theme="light"], [data-theme="dark"] { ${declarations} }`;
}

/**
 * The rule a frame's sheet ends with: the chosen theme's tokens, or the base's
 * own for none, so a frame born in a theme is put back whole when told Dark
 * or Light.
 */
export function frameThemeRule(
  base: Theme,
  saved: string | undefined | null,
  own: readonly OwnThemeColors[] = [],
): string {
  const theme = themeOf(saved, own);
  return themeRule(theme?.base === base ? theme.tokens : shippedTokens(base));
}
