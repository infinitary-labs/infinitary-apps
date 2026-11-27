import { z } from "zod";
import type { ActionLine } from "./actions";
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, isBuiltInTheme, themeOf } from "./colorThemes";
import {
  checkOwnTheme,
  findOwnTheme,
  noOwnTheme,
  type OwnThemeAsk,
  ownThemeAskSchema,
  THEME_COLOR_JOBS,
} from "./ownColorThemes";
import { type Appearance, themeSchema } from "./preferences";
import { ownColorThemesValue, themeChoiceValue } from "./settingValues";

/** What the theme line takes beside the person's own: Dark, Light, or a built-in color theme's id (docs/themes.md). */
const THEME_CHOICES: readonly string[] = ["dark", "light", ...BUILT_IN_THEME_IDS];

// An own theme's id is checked against the look in toRequest, which alone reads the saved ones.
const themeChoiceSchema = z.strictObject({
  theme: z.string().refine((id) => THEME_CHOICES.includes(id) || id.startsWith("own-"), {
    // i18n-exempt: served to the first mate, a model, never shown
    message: `Choose one of ${THEME_CHOICES.join(", ")}, or an own- id the own-theme line names.`,
  }),
});
type ThemeChoice = z.infer<typeof themeChoiceSchema>;

/** The look wearing a theme on its base: a theme changes the base only through its background. */
function wearing(look: Appearance, id: string, base: Appearance["theme"]): Appearance {
  return { ...look, theme: base, colorTheme: id };
}

/** Settings → Appearance's Theme row as the first mate's line (primitives/app-actions.md). */
export const themeLines = {
  theme: {
    fields: ["theme", "colorTheme"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: themeChoiceSchema,
    // i18n-exempt: served to the first mate, a model, never shown
    line: `The window's color theme when asked, preserving size, window wash and crew model names: dark, light, a built-in theme by its id (${BUILT_IN_THEME_IDS.map((id) => `${id} for ${BUILT_IN_THEMES[id].name}`).join(", ")}), or one of the person's own by its id (own-theme). A theme changes colors only. Each computer's window keeps its own; the phone keeps its own Theme setting.`,
    // A color theme saves its base as the theme, so whatever knows only Dark and Light follows it.
    toRequest: (v, c) => {
      const { colorTheme: _was, ...look } = c as Appearance;
      const { theme } = v as ThemeChoice;
      if (theme === "dark" || theme === "light")
        return [{ ...look, theme: themeSchema.parse(theme) }];
      const worked = themeOf(theme, look.ownColorThemes);
      if (!worked)
        throw new Error(
          // i18n-exempt: served to the first mate, a model, never shown
          `No theme ${theme}. Themes: ${[...THEME_CHOICES, ...(look.ownColorThemes ?? []).map((own) => own.id)].join(", ")}.`,
        );
      return [wearing(look, theme, worked.base)];
    },
    readValue: themeChoiceValue,
    done: (v) => {
      const { theme, name } = v as ThemeChoice & { name?: string };
      return `switched to the ${isBuiltInTheme(theme) ? BUILT_IN_THEMES[theme].name : (name ?? theme)} theme`;
    },
  },
  // A person's own color themes (docs/themes.md, "Your own themes"). The
  // theme is six colors the app checks here, never code; the window works
  // out every token from them, so a color written here is only a seed.
  "own-theme": {
    fields: ["ownColorThemes", "colorTheme", "theme"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({
      save: ownThemeAskSchema
        .optional()
        .describe("A theme to save under its name, replacing one of that name, and wear"),
      remove: z.string().min(1).max(40).optional().describe("A saved theme's name or id to remove"),
    }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: `Make the window's color theme a person describes as their own, or remove one, when asked: save wears it at once in this window, and saving under a saved theme's name changes that theme. A theme is six colors, each #rrggbb: ${Object.entries(
      THEME_COLOR_JOBS,
    )
      .map(([job, words]) => `${job} (${words})`)
      .join(
        ", ",
      )}. Start from a built-in theme with like and give only the colors the words change, or give background and accent at least; a color left out comes from like, else from Dark or Light. The app keeps every color readable by moving its lightness only; the answer's moved names each color it moved, so tell the person. It refuses a theme whose accent, hot and danger are too close to tell apart, naming them: choose hues further apart and save again. The current value names the saved themes; to change one, read it whole with app_state read theme.own-theme and save it changed.`,
    toRequest: (v, current) => {
      const look = current as Appearance;
      const saved = look.ownColorThemes ?? [];
      const save = v.save as OwnThemeAsk | undefined;
      const remove = v.remove as string | undefined;
      // i18n-exempt: served to the first mate, a model, never shown
      const oneOf = () => new Error("Give save or remove, one of them.");
      if (save && remove !== undefined) throw oneOf();
      if (save) {
        const checked = checkOwnTheme(save);
        if ("refusal" in checked) throw new Error(checked.refusal);
        const { theme, worked } = checked;
        const at = saved.findIndex((own) => own.id === theme.id);
        const themes =
          at === -1 ? [...saved, theme] : saved.map((own, i) => (i === at ? theme : own));
        return [wearing({ ...look, ownColorThemes: themes }, theme.id, worked.base)];
      }
      if (remove === undefined) throw oneOf();
      const gone = findOwnTheme(saved, remove);
      if (!gone) throw new Error(noOwnTheme(remove, saved));
      // A removed theme that was worn leaves its base: the look already holds it.
      const { colorTheme, ...rest } = look;
      return [
        {
          ...rest,
          ...(colorTheme === undefined || colorTheme === gone.id ? {} : { colorTheme }),
          ownColorThemes: saved.filter((own) => own !== gone),
        },
      ];
    },
    readValue: ownColorThemesValue,
    // The value names the themes alone, so a theme saved again under its name
    // reads the same before and after: the trail compares the whole themes.
    trailOf: (_args, result, before) =>
      JSON.stringify((before as Appearance | null)?.ownColorThemes ?? []) ===
      JSON.stringify((result as Appearance).ownColorThemes ?? [])
        ? null
        : ownColorThemesValue(result),
    // The Activity line reads the value as it stands after the change.
    done: (v) => {
      const names = ((v.saved ?? []) as { name: string }[]).map((own) => own.name);
      // i18n-exempt: an Activity line in English, as the own-style line's (src/shared/ambientActions.ts)
      return names.length > 0
        ? `your own color themes: ${names.join(", ")}`
        : "no own color themes saved";
    },
  },
} as const satisfies Record<string, ActionLine>;
