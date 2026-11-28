import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { staleGeneratedFile } from "./github-errors.ts";

/** SwiftUI reads the design skill's colors, spacing and radii, not a parallel theme. */
const css = readFileSync(join(REPO_ROOT, ".claude/skills/infinitary-design/tokens/colors.css"), "utf8");
const [dark, light] = css.split('[data-theme="light"]{');
function rgba(scope: string, token: string): string {
  const value = new RegExp(`--${token}:([^;]+);`).exec(scope)?.[1]?.trim();
  if (!value) throw new Error(`Missing ${token}`);
  const hex = /^#([\da-f]{6})$/i.exec(value);
  const rgb = /^rgba\((\d+), ?(\d+), ?(\d+), ?([\d.]+)\)$/.exec(value);
  const parts = hex ? [0, 2, 4].map((at) => Number.parseInt(hex[1]!.slice(at, at + 2), 16) / 255).concat(1)
    : rgb ? [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, Number(rgb[4])] : null;
  if (!parts) throw new Error(`Not a direct color: ${token}`);
  return `UIColor(red: ${parts[0]}, green: ${parts[1]}, blue: ${parts[2]}, alpha: ${parts[3]})`;
}
const tokens = { background: "bg-0", surface: "bg-2", line: "line-1", text: "fg-1", secondary: "fg-2", accent: "accent", ok: "ok", warning: "warn", danger: "danger", muted: "fg-3", panel: "bg-1", captain: "captain", wire: "wire-accent", wireDim: "wire-dim", wireHot: "wire-hot", hot: "hot",
  // INF-1926: the crew summary's brighter hairline, idle marks, quiet bar fill, lit plan dot and intelligence levels.
  lineStrong: "line-2", idle: "idle", raised: "bg-3", accentDim: "accent-dim",
  slotPremium: "slot-premium", slotHigh: "slot-high", slotMedium: "slot-medium", slotLow: "slot-low" };
const geometry = ["spacing.css", "effects.css"].map((file) => readFileSync(join(REPO_ROOT, ".claude/skills/infinitary-design/tokens", file), "utf8")).join("\n");
const lengths = { space2: "space-2", space3: "space-3", space4: "space-4", space5: "space-5", controlRadius: "radius-m", cardRadius: "radius-l" };
const metrics = Object.entries(lengths).map(([name, token]) => {
  const value = new RegExp(`--${token}:([\\d.]+)px;`).exec(geometry)?.[1];
  if (!value) throw new Error(`Missing native length ${token}`);
  return `    static let ${name}: CGFloat = ${Number(value)}`;
}).join("\n");
/** A surface's move (--dur-med on --ease-out), such as a card turning over to its thread (INF-1919). */
const surfaceMs = /--dur-med:([\d.]+)ms;/.exec(geometry)?.[1];
const glide = /--ease-out:cubic-bezier\(([^)]+)\);/.exec(geometry)?.[1]?.split(",").map(Number);
if (!surfaceMs || glide?.length !== 4) throw new Error("Missing --dur-med or --ease-out");
/** INF-3110: a card paging in (--dur-page) and the one fade reduced motion keeps (--dur-fade), as seconds. */
const pageMs = /--dur-page:([\d.]+)ms;/.exec(geometry)?.[1];
const fadeMs = /--dur-fade:([\d.]+)ms;/.exec(geometry)?.[1];
if (!pageMs || !fadeMs) throw new Error("Missing --dur-page or --dur-fade");
const motion = [
  `    static let surfaceMove = Animation.timingCurve(${glide.join(", ")}, duration: ${Number(surfaceMs) / 1000})`,
  `    static let glide: (Double, Double, Double, Double) = (${glide.join(", ")})`,
  `    static let surfaceSeconds: Double = ${Number(surfaceMs) / 1000}`,
  `    static let pageSeconds: Double = ${Number(pageMs) / 1000}`,
  `    static let fadeSeconds: Double = ${Number(fadeMs) / 1000}`,
].join("\n");
/** The character's wire and halo multipliers, which the light theme raises where thin lines wash out. */
function scalar(scope: string, token: string): number {
  const value = new RegExp(`--${token}:([\\d.]+);`).exec(scope)?.[1];
  if (!value) throw new Error(`Missing ${token}`);
  return Number(value);
}
const scalars = { wireBoost: "wire-boost", haloBoost: "halo-boost" };
const boosts = Object.entries(scalars).map(([name, token]) => `    static func ${name}(_ scheme: ColorScheme) -> Double { scheme == .light ? ${scalar(light!, token)} : ${scalar(dark!, token)} }`).join("\n");
/**
 * INF-1524: a card's raised surface is the Mac's solid card material, `--acrylic-shadow` in effects.css: an inset light
 * top edge and soft drop shadows, each read as written for each appearance.
 */
const [effectsDark, effectsLight] = readFileSync(join(REPO_ROOT, ".claude/skills/infinitary-design/tokens/effects.css"), "utf8").split('[data-theme="light"]{');
function cardShadow(scope: string) {
  const value = /--acrylic-shadow:([^;]+);/.exec(scope)?.[1]?.trim();
  if (!value) throw new Error("Missing acrylic-shadow");
  const parts = value.split(/,(?![^(]*\))/).map((part) => part.trim());
  const read = (part: string) => {
    const match = /^(inset )?(-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)?(?: (-?[\d.]+)(?:px)?)? (rgba\([^)]+\))$/.exec(part);
    if (!match) throw new Error(`Not a shadow the phone draws: ${part}`);
    const color = rgba(`--shadow:${match[6]};`, "shadow");
    return { inset: Boolean(match[1]), x: Number(match[2]), y: Number(match[3]), blur: Number(match[4]), spread: Number(match[5] ?? 0), color };
  };
  const shadows = parts.map(read);
  const edge = shadows.filter((shadow) => shadow.inset);
  if (edge.length !== 1 || edge[0]!.x !== 0 || edge[0]!.blur !== 0) throw new Error("The card's top edge is one sharp inset line");
  return { edge: edge[0]!, drops: shadows.filter((shadow) => !shadow.inset) };
}
const darkCard = cardShadow(effectsDark!), lightCard = cardShadow(effectsLight!);
const drops = (card: ReturnType<typeof cardShadow>) => `[${card.drops.map((drop) => `PhoneShadow(color: Color(uiColor: ${drop.color}), x: ${drop.x}, y: ${drop.y}, blur: ${drop.blur}, spread: ${drop.spread})`).join(", ")}]`;
const card = `    /// The card's light top edge: a line this tall inside its top.\n    static func cardEdgeHeight(_ scheme: ColorScheme) -> CGFloat { scheme == .light ? ${lightCard.edge.y} : ${darkCard.edge.y} }\n    static let cardEdge = Color(uiColor: UIColor { traits in\n        traits.userInterfaceStyle == .light ? ${lightCard.edge.color} : ${darkCard.edge.color}\n    })\n    /// The card's drop shadows, as CSS writes them: offset, blur and spread.\n    static func cardShadows(_ scheme: ColorScheme) -> [PhoneShadow] { scheme == .light ? ${drops(lightCard)} : ${drops(darkCard)} }`;
/**
 * The built-in color themes (docs/themes.md), worked out by the computer's own `workOutTheme` so the phone holds no
 * second copy of the math: each theme's palette is written here, and a theme sits on Dark or Light, its base.
 */
const runner = await openModuleRunner();
const { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, builtInTheme, SHIPPED_ON_ACCENT } = await runner
  .import<typeof import("../src/shared/colorThemes.ts")>(join(REPO_ROOT, "src/shared/colorThemes.ts"))
  .finally(() => runner.close());
const themeCase = (id: string) => id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const tokenNames = Object.keys(tokens);
const paletteOf = (color: (token: string) => string, onAccent: string) =>
  `PhonePalette(${tokenNames.map((name) => `${name}: ${color(tokens[name as keyof typeof tokens])}`).join(", ")}, onAccent: ${onAccent})`;
// Dark and Light keep the fixed near-black their own --on-accent names in the window's colors.css.
const shippedPalette = (scope: string) => paletteOf((token) => rgba(scope, token), rgba(`--on-accent:${SHIPPED_ON_ACCENT};`, "on-accent"));
const themePalette = (id: (typeof BUILT_IN_THEME_IDS)[number]) => {
  const worked = builtInTheme(id);
  if (worked.faults.length) throw new Error(`${id} has faults: ${worked.faults.join("; ")}`);
  const scope = Object.entries(worked.tokens).map(([name, value]) => `${name}:${value};`).join("");
  return paletteOf((token) => rgba(scope, token), rgba(scope, "on-accent"));
};
const palettes = [
  "/// Every color a palette holds, one per `PhoneTheme` color, and the words on an accent-filled control.",
  `struct PhonePalette: Sendable {\n    let ${tokenNames.join(", ")}, onAccent: UIColor\n}`,
  "",
  "extension PhonePalette {",
  `    static let dark = ${shippedPalette(dark!)}`,
  `    static let light = ${shippedPalette(light!)}`,
  "    /// Each built-in theme's colors, worked out by the computer's `workOutTheme`; built once, since every color lookup reads one.",
  ...BUILT_IN_THEME_IDS.map((id) => `    static let ${themeCase(id)} = ${themePalette(id)}`),
  "}",
  "",
  "extension PhonePalette {",
  "    /// A person's own theme from the tokens the computer worked out (`PhoneOwnTheme`). A token missing or unreadable,",
  "    /// such as one a later phone reads that an older computer never sent, takes `base`'s color, so the theme still draws.",
  "    init(tokens: [String: String], base: PhonePalette) {",
  "        func color(_ name: String) -> UIColor? { tokens[name].flatMap(PhonePalette.color) }",
  `        self.init(${tokenNames.map((name) => `${name}: color("--${tokens[name as keyof typeof tokens]}") ?? base.${name}`).join(", ")}, onAccent: color("--on-accent") ?? base.onAccent)`,
  "    }",
  "}",
  "",
  "extension PhoneColorTheme {",
  "    var palette: PhonePalette {",
  "        switch self {",
  ...BUILT_IN_THEME_IDS.map((id) => `        case .${themeCase(id)}: .${themeCase(id)}`),
  "        }",
  "    }",
  "}",
].join("\n");
const text = `// Generated by scripts/generate-phone-theme.ts from the design skill and the built-in color themes.\nimport InfinitaryKit\nimport SwiftUI\nimport UIKit\n\nenum PhoneTheme {\n    static let onAccent = Color(uiColor: UIColor { PhoneTheme.palette($0).onAccent })\n${metrics}\n${motion}\n${tokenNames.map((name) => `    static let ${name} = Color(uiColor: UIColor { PhoneTheme.palette($0).${name} })`).join("\n")}\n${boosts}\n${card}\n}\n\nstruct PhoneShadow { let color: Color; let x: CGFloat; let y: CGFloat; let blur: CGFloat; let spread: CGFloat }\n\n${palettes}\n`;
/** The theme list InfinitaryKit's `PhoneLook` saves and names: ids, makers' names and each base. */
const kit = [
  "// Generated by scripts/generate-phone-theme.ts from the built-in color themes (src/shared/colorThemes.ts).",
  "",
  "/// A built-in color theme, under its maker's name in every language, in the order Settings lists them.",
  "public enum PhoneColorTheme: String, CaseIterable, Sendable {",
  ...BUILT_IN_THEME_IDS.map((id) => `    case ${themeCase(id)} = "${id}"`),
  "",
  "    /// Its maker's name, shown untranslated.",
  "    public var name: String {",
  "        switch self {",
  ...BUILT_IN_THEME_IDS.map((id) => `        case .${themeCase(id)}: ${JSON.stringify(BUILT_IN_THEMES[id].name)}`),
  "        }",
  "    }",
  "",
  "    /// Whether it sits on Dark; otherwise it sits on Light.",
  "    public var isDark: Bool {",
  "        switch self {",
  ...BUILT_IN_THEME_IDS.map((id) => `        case .${themeCase(id)}: ${builtInTheme(id).base === "dark"}`),
  "        }",
  "    }",
  "}",
  "",
].join("\n");
// The launch screen is drawn by the system before any Swift runs, so it reads the void from an asset.
function launchColor(scope: string, darkVariant: boolean) {
  const value = /--bg-0:#([\da-f]{6});/i.exec(scope)?.[1];
  if (!value) throw new Error("Missing bg-0");
  const [red, green, blue] = [0, 2, 4].map((at) => `0x${value.slice(at, at + 2).toUpperCase()}`);
  return { ...(darkVariant ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
    color: { "color-space": "srgb", components: { alpha: "1.000", blue, green, red } }, idiom: "universal" };
}
const launch = `${JSON.stringify({ colors: [launchColor(light!, false), launchColor(dark!, true)], info: { author: "xcode", version: 1 } }, null, 2)}\n`;
const outputs = {
  "ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift": text,
  "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneColorThemes.generated.swift": kit,
  "ios/Infinitary/InfinitaryApp/Assets.xcassets/LaunchBackground.colorset/Contents.json": launch,
};
for (const [file, contents] of Object.entries(outputs)) {
  const path = join(REPO_ROOT, file);
  if (process.argv.includes("--check")) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== contents) throw staleGeneratedFile(file, "node scripts/generate-phone-theme.ts");
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
