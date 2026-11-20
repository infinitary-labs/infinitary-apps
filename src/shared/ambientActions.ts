import { z } from "zod";
import type { ActionLine } from "./actions";
import {
  OWN_STYLES_MAX,
  type OwnStyle,
  ownStyleFaults,
  ownStyleId,
  ownStyleSchema,
} from "./ambientOwn";
import {
  AMBIENT_STYLES,
  type Appearance,
  ambientStyleIn,
  ambientStyleSchema,
  ambientVolumeSchema,
  DEFAULT_AMBIENT_STYLE,
  DEFAULT_AMBIENT_VOLUME,
} from "./preferences";
import { ambientMusicValue, ambientOwnStylesValue, ambientPausedValue } from "./settingValues";

/** The ambient music's lines in the app action catalog (docs/ambient-music.md). */
export const ambientLines = {
  "ambient-music": {
    fields: ["ambientMusic", "ambientPaused", "ambientVolume", "ambientStyle"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z
      .strictObject({
        on: z.boolean(),
        paused: z.boolean().optional(),
        volume: ambientVolumeSchema.optional(),
        style: ambientStyleSchema.optional(),
      })
      .refine((v) => v.on || v.paused !== true, { message: "Only music that is on can pause." }),
    line: `Play, pause or stop the ambient music when asked, optionally at a volume of 0-100 percent and in one of its styles (${AMBIENT_STYLES.join(", ")}; ${DEFAULT_AMBIENT_STYLE} is the default) or one of the person's own by its id (ambient-own-style): calm music made on the computer that follows the crew. on true plays it, even when it was paused; paused true with on true pauses it, as its sound button does.`,
    // As the Settings switch: turning it on or off takes any pause away (INF-5347).
    toRequest: (v, current) => {
      const look = current as Appearance;
      const style = v.style as string | undefined;
      if (style !== undefined && ambientStyleIn(style, look.ambientOwnStyles) !== style)
        throw new Error(
          `No style ${style}. Styles: ${[...AMBIENT_STYLES, ...(look.ambientOwnStyles ?? []).map((own) => own.id)].join(", ")}.`,
        );
      return [
        {
          ...look,
          ambientMusic: v.on,
          ambientPaused: v.paused === true,
          ambientVolume:
            (v.volume as number | undefined) ?? look.ambientVolume ?? DEFAULT_AMBIENT_VOLUME,
          ...(style === undefined ? {} : { ambientStyle: style }),
        },
      ];
    },
    readValue: (current) => ({ ...ambientMusicValue(current), ...ambientPausedValue(current) }),
    done: (v) =>
      `ambient music ${v.on ? (v.paused ? "paused" : "on") : "off"}, volume ${v.volume}%${v.style ? `, style ${v.style}` : ""}`,
  },
  // A person's own ambient styles (docs/ambient-music.md, "Your own styles").
  // The style is settings the app checks here, never code; the window
  // balances its loudness, so a level written here is only a starting mix.
  "ambient-own-style": {
    fields: ["ambientOwnStyles", "ambientStyle", "ambientMusic"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({
      save: ownStyleSchema
        .optional()
        .describe("A style to save under its name, replacing one of that name, and play"),
      remove: z.string().min(1).max(40).optional().describe("A saved style's name or id to remove"),
    }),
    line: `Write the ambient music a person describes as their own style, or remove one, when asked: save plays it at once, and saving under a saved style's name changes that style. It is original music for the app's own instruments in the mood asked for, never a copy of a named song. The instruments make tones, sea waves, soft rain and wind; they cannot make voices singing words, recorded instruments or sounds such as birds, so when asked for those say so and offer the nearest the app can play. Start from a shipped style with like and change only what the words name, or write every field; the current value holds the saved styles to change. The app sets each layer's loudness itself. At most ${OWN_STYLES_MAX} are kept.`,
    toRequest: (v, current) => {
      const look = current as Appearance;
      const saved = look.ambientOwnStyles ?? [];
      const save = v.save as OwnStyle | undefined;
      const remove = v.remove as string | undefined;
      if ((save === undefined) === (remove === undefined))
        throw new Error("Give save or remove, one of them.");
      if (save) {
        const faults = ownStyleFaults(save);
        if (faults.length > 0)
          throw new Error(`The style was not saved, and nothing changed. ${faults.join(" ")}`);
        const id = ownStyleId(save.name);
        const others = saved.filter((own) => own.id !== id);
        if (others.length >= OWN_STYLES_MAX)
          throw new Error(
            `${OWN_STYLES_MAX} styles are saved already; remove one first. Saved: ${saved.map((own) => own.name).join(", ")}.`,
          );
        const at = saved.findIndex((own) => own.id === id);
        const styles =
          at === -1
            ? [...saved, { ...save, id }]
            : saved.map((own, i) => (i === at ? { ...save, id } : own));
        return [{ ...look, ambientOwnStyles: styles, ambientStyle: id, ambientMusic: true }];
      }
      const gone = saved.find(
        (own) => own.id === remove || own.name.toLowerCase() === remove?.toLowerCase(),
      );
      if (!gone)
        throw new Error(
          `No own style ${remove}. Saved: ${saved.map((own) => own.name).join(", ") || "none"}.`,
        );
      return [
        {
          ...look,
          ambientOwnStyles: saved.filter((own) => own !== gone),
          ...(look.ambientStyle === gone.id ? { ambientStyle: DEFAULT_AMBIENT_STYLE } : {}),
        },
      ];
    },
    readValue: ambientOwnStylesValue,
    // The Activity line reads the value as it stands after the change.
    done: (v) => {
      const names = ((v.saved ?? []) as { name: string }[]).map((own) => own.name);
      return names.length > 0
        ? `your own ambient styles: ${names.join(", ")}`
        : "no own ambient styles saved";
    },
  },
} as const satisfies Record<string, ActionLine>;
