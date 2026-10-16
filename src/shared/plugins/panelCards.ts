import { z } from "zod";
import { type KeyChord, PANEL_COMMAND_ID_MAX, panelCommandId } from "../keyboard";
import type {
  PanelCardDeclaration,
  PanelCardEmit,
  PanelCardHeight,
  PanelCardWidth,
  PanelCommandDeclaration,
  PanelHeaderButton,
  PanelHeaderIcon,
  StoreValue,
} from "../personal/contracts";

/**
 * The cards a panel puts up on the main card stack, and the header buttons
 * and commands that put them up (FI3-1014 piece 1, built by FI3-1015;
 * docs/ui-plugins.md "A panel's cards"). One shape for every panel,
 * whoever made it: a folder's `manifest.json` names the cards its header
 * buttons and commands put up (`cards`), the buttons (`header`) and the
 * commands (`commands`); its `cards/<view>.tsx` files are the card views;
 * and its code puts up any number of cards with `cards.emit`. Data only
 * here: the schemas both the core and the window read, the bounds, and the
 * one check that every name a manifest uses is one it declares.
 */

/** The widths a panel's card may ask for: the stack's own (docs/card-authoring.md). */
export const PANEL_CARD_WIDTHS = ["regular", "wide", "full"] as const;
export const panelCardWidthSchema: z.ZodType<PanelCardWidth> = z.enum(PANEL_CARD_WIDTHS);

/** The width a card takes when its panel names none: the stack's own default. */
export const DEFAULT_PANEL_CARD_WIDTH: PanelCardWidth = "wide";

/** How tall a panel's card may be: as its view, or the stage's height, its view scrolling itself. */
export const PANEL_CARD_HEIGHTS = ["content", "fill"] as const;
export const panelCardHeightSchema: z.ZodType<PanelCardHeight> = z.enum(PANEL_CARD_HEIGHTS);

/** The height a card takes when its panel names none: as tall as its view. */
export const DEFAULT_PANEL_CARD_HEIGHT: PanelCardHeight = "content";

/**
 * The icons a header button may wear: the app draws them, so a panel names
 * one and never brings its own (the design skill's `Panel.prompt.md`).
 */
export const PANEL_HEADER_ICONS = [
  "open",
  "search",
  "add",
  "list",
  "note",
  "filter",
  "clock",
  "chart",
] as const;
export const panelHeaderIconSchema: z.ZodType<PanelHeaderIcon> = z.enum(PANEL_HEADER_ICONS);

/** How many header buttons a panel may have: the header is a rail wide. */
export const PANEL_HEADER_MAX = 3;
/** How many commands one panel may add to command search. */
export const PANEL_COMMANDS_MAX = 16;
/** How many named cards and how many card views one panel may declare. */
export const PANEL_CARD_VIEWS_MAX = 16;
/**
 * How many of one panel's cards may be open on the stack at once: a guard,
 * so a panel cannot bury the captain's own cards (the plan's assumption).
 */
export const PANEL_OPEN_CARDS_MAX = 50;
/**
 * The most JSON one card's data may take. A card's data rides the frame's
 * one action value (`ACTION_VALUE_MAX_BYTES`, 4 KB) with its title and view,
 * so it is held under that here for a panel in either realm.
 */
export const PANEL_CARD_DATA_MAX_BYTES = 3_072;

/**
 * The most JSON one card may keep (`card.keep`), in UTF-8 bytes: its place
 * rides the frame's one action value on its own, so it takes all of it.
 */
export const PANEL_CARD_KEPT_MAX_BYTES = 4_096;

/** A name inside one panel: a card view, a named card, a button, a command, a card id. */
export const PANEL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const panelNameSchema = z.string().min(1).max(32).regex(PANEL_NAME_PATTERN, "kebab-case");

/** A card's own id, as `cards.emit` takes it: a name, or anything plain up to 64 characters. */
export const PANEL_CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const panelCardIdSchema = z.string().regex(PANEL_CARD_ID_PATTERN, "a plain id");

const panelCardTitleSchema = z.string().min(1).max(80);

const storeValueSchema: z.ZodType<StoreValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(storeValueSchema),
    z.record(z.string(), storeValueSchema),
  ]),
);

/** A card's data: JSON, bounded so it fits one frame message beside its title. */
export const panelCardDataSchema: z.ZodType<StoreValue> = storeValueSchema.refine(
  (value) => JSON.stringify(value).length <= PANEL_CARD_DATA_MAX_BYTES,
  `a card's data is at most ${PANEL_CARD_DATA_MAX_BYTES} bytes of JSON`,
);

/** A card's kept place: JSON, at most `PANEL_CARD_KEPT_MAX_BYTES` bytes of it. */
export const panelCardKeptSchema: z.ZodType<StoreValue> = storeValueSchema.refine(
  (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= PANEL_CARD_KEPT_MAX_BYTES,
  `a card keeps at most ${PANEL_CARD_KEPT_MAX_BYTES} bytes of JSON`,
);

/** One card the manifest names, for a header button or a command to put up. */
export const panelCardDeclarationSchema: z.ZodType<PanelCardDeclaration> = z.strictObject({
  view: panelNameSchema,
  title: panelCardTitleSchema,
  width: panelCardWidthSchema.optional(),
  height: panelCardHeightSchema.optional(),
  data: panelCardDataSchema.optional(),
});

/**
 * A header button: it puts up one of the named cards (`emits`, with `data`
 * in place of the card's own), or, naming none, it is pressed into the
 * panel as an ask (`asks.subscribe`).
 */
export const panelHeaderButtonSchema: z.ZodType<PanelHeaderButton> = z.strictObject({
  id: panelNameSchema,
  icon: panelHeaderIconSchema,
  label: z.string().min(1).max(40),
  emits: panelNameSchema.optional(),
  data: panelCardDataSchema.optional(),
});

/** How many other words one command may be found by, and how long each may be. */
export const PANEL_COMMAND_WORDS_MAX = 8;
export const PANEL_COMMAND_WORD_MAX = 24;

/**
 * A command in command search: it puts up one of the named cards (`emits`)
 * or presses one of the header buttons (`presses`), exactly one of the two.
 * `key` suggests a key as a Mac writes it (`⌘B`, `⇧⌘F`, `⌃⌥N`, `F7`); the
 * app gives it only where no other command already uses it. `words` are
 * other words command search finds it by.
 */
export const panelCommandDeclarationSchema: z.ZodType<PanelCommandDeclaration> = z
  .strictObject({
    id: panelNameSchema,
    label: z.string().min(1).max(60),
    emits: panelNameSchema.optional(),
    presses: panelNameSchema.optional(),
    data: panelCardDataSchema.optional(),
    key: z
      .string()
      .min(1)
      .max(12)
      .refine((key) => parseSuggestedKey(key) !== null, "a key as a Mac writes it, such as ⌘B")
      .optional(),
    words: z
      .array(z.string().min(1).max(PANEL_COMMAND_WORD_MAX).regex(/^\S+$/, "one word"))
      .max(PANEL_COMMAND_WORDS_MAX)
      .optional(),
  })
  .refine(
    (command) => (command.emits === undefined) !== (command.presses === undefined),
    "a command either emits a card or presses a header button",
  );

/** What `cards.emit` takes, checked at the boundary in either realm. */
export const panelCardEmitSchema: z.ZodType<PanelCardEmit> = z.strictObject({
  id: panelCardIdSchema.optional(),
  view: panelNameSchema,
  title: panelCardTitleSchema,
  width: panelCardWidthSchema.optional(),
  height: panelCardHeightSchema.optional(),
  data: panelCardDataSchema.optional(),
});

export const panelCardsDeclarationSchema = z
  .record(panelNameSchema, panelCardDeclarationSchema)
  .refine(
    (cards) => Object.keys(cards).length <= PANEL_CARD_VIEWS_MAX,
    `at most ${PANEL_CARD_VIEWS_MAX} named cards`,
  );
export const panelHeaderSchema = z.array(panelHeaderButtonSchema).max(PANEL_HEADER_MAX);
export const panelCommandsSchema = z.array(panelCommandDeclarationSchema).max(PANEL_COMMANDS_MAX);

/** The modifier glyphs a suggested key may lead with, as a Mac writes them. */
const MODIFIER_GLYPHS: Readonly<Record<string, keyof Omit<KeyChord, "key">>> = {
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
  "⌘": "meta",
};

/**
 * A suggested key as the chord the window matches, or null when it is not
 * one: modifier glyphs in any order, then one character or a function key
 * (`⌘B` is `b` with ⌘, `⇧⌘F` is `f` with ⇧ and ⌘, `F7` is F7 alone).
 * Whether the window can give it is the keymap's call, at install.
 */
export function parseSuggestedKey(text: string): KeyChord | null {
  const chord: KeyChord = { key: "" };
  let rest = text;
  while (rest.length > 0) {
    const modifier = MODIFIER_GLYPHS[rest[0] as string];
    if (!modifier) break;
    if (chord[modifier]) return null;
    chord[modifier] = true;
    rest = rest.slice(1);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(rest)) return { ...chord, key: rest };
  if ([...rest].length !== 1 || /\s/.test(rest)) return null;
  return { ...chord, key: /^[A-Za-z]$/.test(rest) ? rest.toLowerCase() : rest };
}

/** The view file a card view is compiled from, inside its panel's folder. */
export function panelCardViewSource(view: string): string {
  return `cards/${view}.tsx`;
}

/** The compiled module a card view is served as, beside its panel's `panel.mjs`. */
export function panelCardViewModule(view: string): string {
  return `cards/${view}.mjs`;
}

/** What a panel declares about its cards, as its manifest says it. */
export type PanelCardsDeclared = {
  cards?: Record<string, PanelCardDeclaration>;
  header?: PanelHeaderButton[];
  commands?: PanelCommandDeclaration[];
};

/**
 * The first name a panel's manifest uses that it does not declare, in the
 * words an author reads, or null: a named card whose view has no file, a
 * button or command that puts up a card the manifest does not name, a
 * command that presses a button the header does not have, two buttons or
 * two commands with one id, and a command whose id with its panel's is
 * longer than a saved key may be named by.
 */
export function panelCardsProblem(
  declared: PanelCardsDeclared,
  views: readonly string[],
  panel: string,
): string | null {
  const named = declared.cards ?? {};
  for (const [name, card] of Object.entries(named)) {
    if (!views.includes(card.view)) {
      return `cards.${name} names the view "${card.view}", but there is no ${panelCardViewSource(card.view)}`;
    }
  }
  const buttons = declared.header ?? [];
  const seenButtons = new Set<string>();
  for (const button of buttons) {
    if (seenButtons.has(button.id)) return `header has two buttons with the id "${button.id}"`;
    seenButtons.add(button.id);
    if (button.emits !== undefined && !Object.hasOwn(named, button.emits)) {
      return `header button "${button.id}" puts up "${button.emits}", which cards does not name`;
    }
  }
  const seenCommands = new Set<string>();
  for (const command of declared.commands ?? []) {
    if (seenCommands.has(command.id)) return `commands has two with the id "${command.id}"`;
    seenCommands.add(command.id);
    if (panelCommandId(panel, command.id).length > PANEL_COMMAND_ID_MAX) {
      return `command "${command.id}" makes the id ${panelCommandId(panel, command.id)}, longer than ${PANEL_COMMAND_ID_MAX} characters; shorten the command's id`;
    }
    if (command.emits !== undefined && !Object.hasOwn(named, command.emits)) {
      return `command "${command.id}" puts up "${command.emits}", which cards does not name`;
    }
    if (command.presses !== undefined && !seenButtons.has(command.presses)) {
      return `command "${command.id}" presses "${command.presses}", which header does not have`;
    }
  }
  return null;
}

/** A manifest without its cards, buttons and commands: what a panel keeps when they are refused. */
export function withoutPanelCards<T extends PanelCardsDeclared>(
  manifest: T,
): Omit<T, "cards" | "header" | "commands"> {
  const { cards: _cards, header: _header, commands: _commands, ...rest } = manifest;
  return rest;
}
