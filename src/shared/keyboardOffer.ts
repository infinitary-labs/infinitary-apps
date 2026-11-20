import { z } from "zod";

/** A document offers a key, never a command; the main process must have witnessed the same press. */
export const offeredKeySchema = z.object({
  key: z.string().min(1).max(32),
  code: z.string().max(32),
  meta: z.boolean(),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  composing: z.boolean(),
  repeat: z.boolean(),
});

/** Text-like inputs keep their letters; radios, checkboxes and buttons are not typing. */
export const TYPING_CONTROL_SELECTOR =
  'textarea, select, [role="textbox"], [data-keyboard-typing], [data-keyboard-recorder], input:not([type="checkbox" i], [type="radio" i], [type="range" i], [type="button" i], [type="submit" i], [type="reset" i], [type="image" i], [type="color" i], [type="file" i], [type="hidden" i])';
