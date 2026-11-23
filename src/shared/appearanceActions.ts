import { z } from "zod";
import type { ActionLine } from "./actions";
import { choosableLanguages } from "./i18n/start";
import type { KeyReminders } from "./keyReminders";
import {
  type Appearance,
  defaultCardSizeSchema,
  uiSizeSchema,
  washStrengthSchema,
} from "./preferences";
import { crewModelNamesValue, sizeValue, washValue } from "./settingValues";
import { DEFAULT_USAGE_UNIT, usageUnitSchema } from "./usage";

/**
 * Settings → Appearance's lines past the theme and fonts, and Usage's unit:
 * each changes its own fields of the one appearance request
 * (primitives/app-actions.md).
 */
export const appearanceLines = {
  "window-wash": {
    fields: ["washStrength"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ strength: washStrengthSchema }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Window wash opacity, 0–100 percent, when asked.",
    toRequest: (v, current) => [{ ...(current as Appearance), washStrength: v.strength }],
    readValue: washValue,
    done: (v) => `window wash ${v.strength}%`,
    settled: (from, to) => `window wash ${from.strength}% → ${to.strength}%`,
  },
  "window-size": {
    fields: ["size"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ size: uiSizeSchema }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Whole-window size, 100, 110, 125 or 150 percent, when asked: larger makes text and everything around it bigger. The size keys and the View menu step through the same sizes.",
    toRequest: (v, current) => [{ ...(current as Appearance), size: v.size }],
    readValue: sizeValue,
    done: (v) => `window size ${v.size}%`,
    settled: (from, to) => `window size ${from.size}% → ${to.size}%`,
  },
  "crew-model-names": {
    fields: ["showCrewModelNames"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ visible: z.boolean() }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Show or hide crew model names when asked.",
    toRequest: (v, current) => [{ ...(current as Appearance), showCrewModelNames: v.visible }],
    readValue: crewModelNamesValue,
    done: (v) => `crew model names ${v.visible ? "shown" : "hidden"}`,
  },
  "ambient-away": {
    fields: ["ambientPlaysWhenAway"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ pause: z.boolean() }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Pause when you're away, when asked: with pause true the ambient music pauses while nobody is at the computer and plays again once someone is back (the default); pause false keeps it playing. Only a Mac or a Windows PC notices nobody is there: on Linux the music never pauses for this, whatever the switch says, so never tell a Linux user it does.",
    toRequest: (v, current) => [{ ...(current as Appearance), ambientPlaysWhenAway: !v.pause }],
    readValue: (current) => ({ pause: (current as Appearance).ambientPlaysWhenAway !== true }),
    done: (v) => `ambient music ${v.pause ? "pauses" : "plays"} while you're away`,
  },
  "card-size": {
    // Keep cards maximized turned on or off forgets the last maximize (cardsMaximized).
    fields: ["defaultCardSize", "keepCardsMaximized", "cardsMaximized"],
    sets: (v) => [
      ...(v.size === undefined ? [] : ["defaultCardSize"]),
      ...(v.keepMaximized === undefined ? [] : ["keepCardsMaximized", "cardsMaximized"]),
    ],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z
      .strictObject({
        size: defaultCardSizeSchema.optional(),
        keepMaximized: z.boolean().optional(),
      })
      .refine((v) => v.size !== undefined || v.keepMaximized !== undefined, {
        // i18n-exempt: served to the first mate, a model, never shown
        message: "Name size, keepMaximized or both.",
      }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "The size a card opens at (usual, wide, full or maximized) and Keep cards maximized, when asked: with it on, every card shows maximized after one is maximized, until one is restored.",
    // As the Settings switch: turning Keep cards maximized on or off forgets the last maximize.
    toRequest: (v, current) => [
      {
        ...(current as Appearance),
        ...(v.size === undefined ? {} : { defaultCardSize: v.size }),
        ...(v.keepMaximized === undefined
          ? {}
          : { keepCardsMaximized: v.keepMaximized, cardsMaximized: false }),
      },
    ],
    readValue: (current) => ({
      size: (current as Appearance).defaultCardSize ?? "usual",
      keepMaximized: (current as Appearance).keepCardsMaximized ?? false,
    }),
    done: (v) => `cards open ${v.size}, keep maximized ${v.keepMaximized ? "on" : "off"}`,
  },
  language: {
    fields: ["language"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({
      language: z
        .string()
        .refine((tag) => choosableLanguages().includes(tag), {
          // i18n-exempt: served to the first mate, a model, never shown
          message: `Choose one of ${choosableLanguages().join(", ")}, or null for the default.`,
        })
        .nullable(),
    }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: `The language the app speaks, when asked: one of ${choosableLanguages().join(", ")} by its tag, or null for the default.`,
    // No language is the default: the core removes the saved choice.
    toRequest: (v, current) => {
      const { language: _was, ...rest } = current as Appearance;
      return [v.language === null ? rest : { ...rest, language: v.language }];
    },
    readValue: (current) => ({ language: (current as Appearance).language ?? null }),
    done: (v) => `language ${v.language ?? "default"}`,
  },
  "usage-unit": {
    fields: ["usageUnit"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ unit: usageUnitSchema }),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Whether Settings → Usage shows amounts in tokens or estimated dollars (usd), when asked.",
    toRequest: (v, current) => [{ ...(current as Appearance), usageUnit: v.unit }],
    readValue: (current) => ({ unit: (current as Appearance).usageUnit ?? DEFAULT_USAGE_UNIT }),
    done: (v) => `usage shown in ${v.unit}`,
  },
  "key-reminders": {
    area: "appearance",
    tier: "asked",
    change: "inf:keyboard:reminders:set",
    current: "inf:keyboard:reminders",
    value: z.strictObject({ on: z.boolean() }),
    line: "Turn the key reminder on or off, as Settings → Keyboard's switch, when asked: after a click on a control that has a key, it names the key for a few seconds. Each computer's window keeps its own; computer names which, this one's when omitted.",
    toRequest: (v) => [v.on],
    readValue: (current) => ({ on: (current as KeyReminders | null)?.on ?? null }),
    done: (v) => `key reminders ${v.on ? "on" : "off"}`,
  },
} as const satisfies Record<string, ActionLine>;
