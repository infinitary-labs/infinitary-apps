import { z } from "zod";
import { type CommandId, chordAccelerator, type KeyChord } from "./keyboard";

/**
 * The card overlay (docs/card-overlay.md): on a Mac, one system-wide key
 * shows the card stack in a small panel over whatever is in front, such as
 * a full-screen game, and gives the keys back when it goes. It is this
 * computer's own and off until a person turns it on in Keyboard settings.
 */

/** Control+Shift+O: chosen on INF-7063's plan; ⌘ chords are the front app's own. */
export const CARD_OVERLAY_DEFAULT_KEY: KeyChord = { key: "o", ctrl: true, shift: true };

const overlayChordSchema = z.strictObject({
  key: z.string().min(1).max(32),
  meta: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
});

/** What this computer keeps: the switch and the key. */
export const savedCardOverlaySchema = z.object({
  on: z.boolean(),
  key: overlayChordSchema,
});
export type SavedCardOverlay = z.infer<typeof savedCardOverlaySchema>;

/**
 * Why the overlay's key is not working now: the system would not register
 * it (`taken`), or this computer has no overlay (`unsupported`, every desktop
 * but a Mac's). A key that works has none.
 */
export const CARD_OVERLAY_PROBLEMS = ["taken", "unsupported"] as const;
export type CardOverlayProblem = (typeof CARD_OVERLAY_PROBLEMS)[number];

/** The switch and key as saved, and why the key does not work now, if it does not. */
export const cardOverlaySchema = savedCardOverlaySchema.extend({
  problem: z.enum(CARD_OVERLAY_PROBLEMS).nullable(),
});
export type CardOverlay = z.infer<typeof cardOverlaySchema>;

/**
 * A person's change answered: the switch and key as they are now, and why
 * the change was not made, if it was not - the system would not register
 * the key (`taken`), or the key may not summon (`not-allowed`, `overlayKeyAllowed`).
 */
export const cardOverlaySetSchema = z.object({
  overlay: cardOverlaySchema,
  refused: z.enum(["taken", "not-allowed"]).nullable(),
});
export type CardOverlaySet = z.infer<typeof cardOverlaySetSchema>;
export type CardOverlayRefusal = NonNullable<CardOverlaySet["refused"]>;

export const DEFAULT_CARD_OVERLAY: SavedCardOverlay = {
  on: false,
  key: CARD_OVERLAY_DEFAULT_KEY,
};

/** Keys that never summon: a game's own Escape, Tab, Return and Space, held or not. */
const NEVER_SUMMONS = new Set(["Escape", "Tab", "Enter", " ", "Backspace"]);

/**
 * Whether a chord may be the overlay's key: it holds ⌃, ⌥ or ⌘, so plain
 * typing and a game's Shift-modified movement never press it, and it is
 * not one of the keys a game or a field always uses.
 */
export function overlayKeyAllowed(chord: KeyChord): boolean {
  if (!chord.ctrl && !chord.alt && !chord.meta) return false;
  return !NEVER_SUMMONS.has(chord.key);
}

/** The key as the system's shortcut registry names it (Electron's accelerator). */
export function overlayAccelerator(chord: KeyChord): string {
  return chordAccelerator(chord);
}

/** The air between the panel's card and the display's trailing edge, in points. */
export const OVERLAY_EDGE = 24;
/** The stage's air on each side of its card: half of its 32-point margin (`cardWidth`). */
const STAGE_AIR = 16;
/** The panel's width: a regular card and the stage's own air on both sides of it. */
export const OVERLAY_WIDTH = 560 + 2 * STAGE_AIR;

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where the panel goes on a display: the full height of its work area, at
 * its trailing edge, so the card's own right edge sits `OVERLAY_EDGE` from
 * it. The stage's air is half on each side of the card. A display narrower
 * than the panel gets the whole width, and so does a card made large
 * (`wide`), the plan's deliberate expansion of wide content.
 */
export function overlayBounds(workArea: Rect, rightToLeft = false, wide = false): Rect {
  // A card made large takes the whole work area; its clear air still lets clicks through.
  if (wide) return { ...workArea };
  const width = Math.min(OVERLAY_WIDTH, workArea.width);
  const inset = Math.max(0, Math.min(OVERLAY_EDGE - STAGE_AIR, workArea.width - width));
  const x = rightToLeft ? workArea.x + inset : workArea.x + workArea.width - width - inset;
  return { x, y: workArea.y, width, height: workArea.height };
}

/** The preload's argument that makes a window's page the overlay's. */
const CARD_OVERLAY_ARG = "--inf-card-overlay";
/** The `<html data-card-overlay>` mark the preload sets on the overlay's page before its first paint. */
export const CARD_OVERLAY_ATTRIBUTE = "data-card-overlay";

export function cardOverlayArgument(): string {
  return CARD_OVERLAY_ARG;
}

export function isCardOverlayArgv(argv: readonly string[]): boolean {
  return argv.includes(CARD_OVERLAY_ARG);
}

/**
 * The installed keys the overlay runs: the shown card's own, as in the
 * window (docs/keyboard.md), and none that reach past the card - a side
 * panel, a search, another view. Every other key the window would take
 * does nothing in the overlay.
 */
export function overlayRunsCommand(id: CommandId): boolean {
  if (id.startsWith("cards.show-")) return false;
  return id.startsWith("cards.") || id.startsWith("focus.card-");
}
