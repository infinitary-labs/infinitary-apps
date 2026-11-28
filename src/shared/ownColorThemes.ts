// A person's own color themes (docs/themes.md, "Your own themes"): a theme
// the first mate makes from someone's words, as at most six colors, never
// code. The app works out every token from them and holds each floor
// (./colorThemes.ts); this module is the format, its check and the names
// the action line, the store and the window share.

import { z } from "zod";
import { ownStyleId } from "./ambientOwn";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  isBuiltInTheme,
  shippedTokens,
  type ThemeSeed,
  textFor,
  themeBase,
  type WorkedOutTheme,
  workOutTheme,
} from "./colorThemes";

/** Each color's job, as the first mate is told it and as docs/themes.md's table says it. */
// i18n-exempt: served to the first mate, a model, never shown
export const THEME_COLOR_JOBS = {
  background: "the window's own color; every surface steps from it, and Dark or Light follows it",
  text: "words",
  accent: "calm: done, links, the first mate's light",
  hot: "working and attention",
  danger: "errors",
  captain: "the person's own activity",
} as const satisfies Record<keyof ThemeSeed, string>;

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe("#rrggbb");

const describedColor = (job: keyof ThemeSeed) =>
  color.describe(`#rrggbb: ${THEME_COLOR_JOBS[job]}`);

const nameSchema = z.string().min(1).max(40).describe("The theme's name, as the person said it");

/** A theme as the first mate asks for it: a name, a built-in theme to start from, and the colors that differ. */
export const ownThemeAskSchema = z.strictObject({
  name: nameSchema,
  like: z
    .string()
    .optional()
    .describe("A built-in theme's id to start from: a color left out comes from it"),
  colors: z
    .strictObject({
      background: describedColor("background").optional(),
      text: describedColor("text").optional(),
      accent: describedColor("accent").optional(),
      hot: describedColor("hot").optional(),
      danger: describedColor("danger").optional(),
      captain: describedColor("captain").optional(),
    })
    .describe("background and accent are needed unless like gives them"),
});
export type OwnThemeAsk = z.infer<typeof ownThemeAskSchema>;

/** A saved theme, as the look carries it: every one of its six colors, as asked, before any is moved. */
export const savedOwnThemeSchema = z.strictObject({
  id: z.string().regex(/^own-[a-z0-9-]{1,36}$/),
  name: nameSchema,
  colors: z.strictObject({
    background: color,
    text: color,
    accent: color,
    hot: color,
    danger: color,
    captain: color,
  }),
});
export type SavedOwnTheme = z.infer<typeof savedOwnThemeSchema>;

/** The saved own themes, as the look carries them. */
export const ownColorThemesSchema = z.array(savedOwnThemeSchema);

/** The id a theme's name saves under: own-<words>, the same for the same name, never a built-in theme's. */
export const ownThemeId = ownStyleId;

/** The saved theme a name or id names: a name in any case, an id exactly. */
export function findOwnTheme(
  saved: readonly SavedOwnTheme[],
  nameOrId: string,
): SavedOwnTheme | undefined {
  const name = nameOrId.toLowerCase();
  return saved.find((own) => own.id === nameOrId || own.name.toLowerCase() === name);
}

/** What a name no saved theme has answers: the saved themes' names, to name one of them. */
export function noOwnTheme(nameOrId: string, saved: readonly SavedOwnTheme[]): string {
  // i18n-exempt: served to the first mate in English
  return `No own theme ${nameOrId}. Saved: ${saved.map((own) => own.name).join(", ") || "none"}.`;
}

/** A checked ask: the theme to save and what the app worked out from it, or why nothing was saved. */
export type CheckedOwnTheme =
  | { theme: SavedOwnTheme; worked: WorkedOutTheme }
  | { refusal: string };

/**
 * Fills an ask's six colors and checks them. A color left out comes from
 * `like`; else text is worked out from the background and the rest are
 * Dark's or Light's own, by the background's base. A theme with any fault
 * is refused in words the first mate can act on.
 */
export function checkOwnTheme(ask: OwnThemeAsk): CheckedOwnTheme {
  const refused = (why: string) => ({
    // i18n-exempt: served to the first mate in English
    refusal: `The theme was not saved, and nothing changed. ${why}`,
  });
  if (ask.like !== undefined && !isBuiltInTheme(ask.like))
    // i18n-exempt: served to the first mate in English
    return refused(`No built-in theme ${ask.like}. Built-in: ${BUILT_IN_THEME_IDS.join(", ")}.`);
  const start: Partial<ThemeSeed> = ask.like ? BUILT_IN_THEMES[ask.like].seed : {};
  const given = { ...start, ...ask.colors };
  if (!given.background || !given.accent)
    // i18n-exempt: served to the first mate in English
    return refused("Give background and accent, or like a built-in theme.");
  const shipped = shippedTokens(themeBase(given.background));
  const colors: ThemeSeed = {
    background: given.background,
    text: given.text ?? textFor(given.background, given.accent),
    accent: given.accent,
    hot: given.hot ?? (shipped["--hot"] as string),
    danger: given.danger ?? (shipped["--danger"] as string),
    captain: given.captain ?? (shipped["--captain"] as string),
  };
  const lower = Object.fromEntries(
    Object.entries(colors).map(([job, value]) => [job, value.toLowerCase()]),
  ) as ThemeSeed;
  const worked = workOutTheme(lower);
  // What the app would also have moved tells the first mate which colors were too dim to keep.
  if (worked.faults.length > 0)
    return refused(
      [
        ...worked.faults,
        // i18n-exempt: served to the first mate in English
        ...(worked.moved.length > 0 ? [`The app would also move ${worked.moved.join("; ")}.`] : []),
      ].join(" "),
    );
  return { theme: { id: ownThemeId(ask.name), name: ask.name, colors: lower }, worked };
}

/**
 * A saved theme as a view that holds none of the math draws it, the phone's
 * own Yours (`own-themes-worked.md`): its base and every token the app worked
 * out, `--on-accent` included.
 */
export const workedOwnThemeSchema = z.strictObject({
  id: savedOwnThemeSchema.shape.id,
  name: nameSchema,
  base: z.enum(["dark", "light"]),
  tokens: z.record(z.string(), z.string()),
});
export type WorkedOwnTheme = z.infer<typeof workedOwnThemeSchema>;

/** Every saved theme worked out, in the order Settings lists them under Yours. */
export function workedOwnThemes(saved: readonly SavedOwnTheme[]): WorkedOwnTheme[] {
  return saved.map((own) => {
    const worked = workOutTheme(own.colors);
    return { id: own.id, name: own.name, base: worked.base, tokens: worked.tokens };
  });
}

export function ownThemesRead(appearance: { ownColorThemes?: readonly SavedOwnTheme[] }): {
  themes: WorkedOwnTheme[];
} {
  return { themes: workedOwnThemes(appearance.ownColorThemes ?? []) };
}
