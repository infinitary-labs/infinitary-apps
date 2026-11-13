import { z } from "zod";
import { resolveLanguage } from "./i18n/languages";

/**
 * The fonts the captain chose in Settings → Appearance (docs/fonts.md): one
 * for each of three places the app writes in, each Infinitary's own font
 * unless named. Pure and shared, so the window, its frames and the core read
 * one rule.
 */

/** The three places a font is chosen for, in the order Settings lists them. */
export const FONT_SLOTS = ["app", "reading", "code"] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

/**
 * A font as the computer names its family, such as `Inter` or `Iosevka`, or
 * one of the CSS names for the computer's own font (`COMPUTER_FONTS`). It is
 * written inside a quoted CSS string and inside a frame's `<style>`, so it
 * holds no quote, backslash, angle bracket, brace, semicolon or control
 * character.
 */
export const fontFamilySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^"\\;{}<>\p{Cc}]+$/u);

/**
 * The chosen fonts. A slot left out takes Infinitary's own font, except
 * reading, which then takes the app's font, chosen or not.
 */
export const fontChoicesSchema = z.strictObject({
  app: fontFamilySchema.optional(),
  reading: fontFamilySchema.optional(),
  code: fontFamilySchema.optional(),
});
export type FontChoices = z.infer<typeof fontChoicesSchema>;

/**
 * The computer's own font for each slot, by the CSS name every desktop
 * resolves: San Francisco on a Mac, Segoe UI on Windows, the desktop's own
 * font on Linux, and their monospaced kin for code.
 */
export const COMPUTER_FONTS: Readonly<Record<FontSlot, string>> = {
  app: "system-ui",
  reading: "system-ui",
  code: "ui-monospace",
};

/** Infinitary's own font for each slot (the design skill's type tokens). */
export const OWN_FONTS: Readonly<Record<FontSlot, string>> = {
  app: "Space Grotesk",
  reading: "Space Grotesk",
  code: "JetBrains Mono",
};

const GENERIC_FAMILIES = new Set(["system-ui", "ui-monospace", "ui-sans-serif", "ui-serif"]);

/** A family as CSS writes it: a generic name bare, every other name quoted. */
export function cssFamily(family: string): string {
  return GENERIC_FAMILIES.has(family) ? family : `"${family}"`;
}

/** Which type token's face each slot sets (tokens/typography.css). */
const FACE_TOKENS: Readonly<Record<FontSlot, string>> = {
  app: "--font-ui-face",
  reading: "--font-text-face",
  code: "--font-mono-face",
};

/**
 * The typeface this computer has for each script the brand faces do not
 * draw, for words and for code, keyed by the catalog language that writes
 * in it. The type tokens' `:lang()` rules name the same faces for the app's
 * own language (tokens/typography.css; the test holds the two together).
 */
export const SCRIPT_FACES: Readonly<Record<string, { ui: string[]; mono: string[] }>> = {
  "zh-Hans": {
    ui: ["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei"],
    mono: ["PingFang SC", "Noto Sans Mono CJK SC"],
  },
  "zh-Hant": {
    ui: ["PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei"],
    mono: ["PingFang TC", "Noto Sans Mono CJK TC"],
  },
  ja: {
    ui: ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Yu Gothic UI"],
    mono: ["Hiragino Sans", "Noto Sans Mono CJK JP"],
  },
  ko: {
    ui: ["Apple SD Gothic Neo", "Noto Sans CJK KR", "Malgun Gothic"],
    mono: ["Apple SD Gothic Neo", "Noto Sans Mono CJK KR"],
  },
  ar: {
    ui: ["Geeza Pro", "SF Arabic", "Noto Sans Arabic", "Segoe UI"],
    mono: ["Geeza Pro", "Noto Sans Arabic"],
  },
};

/**
 * The scripts whose faces follow the chosen font, in order: the app's own
 * language's first, then each of the computer's own languages in the order
 * the computer prefers them. So Japanese words in an English window take a
 * Japanese face on a computer that also reads Japanese, rather than
 * whichever face the browser guesses, and Chinese and Japanese, which share
 * many characters, take the face of the language the computer puts first.
 */
export function scriptOrder(appLanguage: string, computerLanguages: readonly string[]): string[] {
  const scripts = Object.keys(SCRIPT_FACES);
  const order: string[] = [];
  for (const tag of [appLanguage, ...computerLanguages]) {
    const script = resolveLanguage([tag], scripts);
    if (script in SCRIPT_FACES && !order.includes(script)) order.push(script);
  }
  return order;
}

/**
 * The type tokens the font choice sets, as custom properties: the face of
 * each chosen slot, its own font after it for any letter it lacks, and the
 * script faces in `scriptOrder`. A slot left out keeps the token's own value.
 * The window sets them on its document; a frame carries them in its
 * stylesheet (`fontStyleRule`).
 */
export function fontDeclarations(
  fonts: FontChoices,
  scripts: readonly string[],
): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const slot of FONT_SLOTS) {
    const family = fonts[slot];
    if (family)
      declarations[FACE_TOKENS[slot]] = `${cssFamily(family)}, ${cssFamily(OWN_FONTS[slot])}`;
  }
  const faces = scripts.flatMap((script) => {
    const entry = SCRIPT_FACES[script];
    return entry ? [entry] : [];
  });
  if (faces.length > 0) {
    declarations["--font-script-ui"] = unique(faces.flatMap((face) => face.ui))
      .map(cssFamily)
      .join(", ");
    declarations["--font-script-mono"] = unique(faces.flatMap((face) => face.mono))
      .map(cssFamily)
      .join(", ");
  }
  return declarations;
}

/**
 * The declarations as a rule a frame's stylesheet ends with. Important, so
 * they win over the tokens' own `:lang()` rules as the window's document
 * style does.
 */
export function fontStyleRule(declarations: Record<string, string>): string {
  const lines = Object.entries(declarations).map(
    ([name, value]) => `${name}: ${value} !important;`,
  );
  return lines.length > 0 ? `:root { ${lines.join(" ")} }` : "";
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * How the main process tells a window's page every language the computer
 * prefers, most preferred first (docs/fonts.md, "Letters in other
 * scripts"): an argument the preload marks on the document under
 * `COMPUTER_LANGUAGES_ATTRIBUTE`.
 */
export const COMPUTER_LANGUAGES_ARG = "--fm-computer-languages=";
export const COMPUTER_LANGUAGES_ATTRIBUTE = "data-computer-languages";
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export function computerLanguagesArgument(tags: readonly string[]): string {
  return `${COMPUTER_LANGUAGES_ARG}${tags.filter((tag) => LANGUAGE_TAG.test(tag)).join(",")}`;
}

/** The computer's languages an argument or a document mark names; none when it names none. */
export function readComputerLanguages(text: string | null | undefined): string[] {
  return (text ?? "").split(",").filter((tag) => LANGUAGE_TAG.test(tag));
}

export function computerLanguagesFromArgv(argv: readonly string[]): string[] {
  return readComputerLanguages(
    argv
      .find((entry) => entry.startsWith(COMPUTER_LANGUAGES_ARG))
      ?.slice(COMPUTER_LANGUAGES_ARG.length),
  );
}
