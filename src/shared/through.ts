import { z } from "zod";

/**
 * How the captain's words or choice reached the app when not from the
 * window (docs/axi-commands.md, "Infinitary from your terminal"): `command`
 * is the captain's own command, `infinitary-axi`, run by the captain, a
 * script or an agent of theirs, with the window's authority. Absent is the
 * window, or a record saved before the mark.
 */
/** The captain's own command's name, which the window and the first mate show beside its mark. */
export const CAPTAIN_COMMAND = "infinitary-axi";

export const THROUGH_THE_COMMAND = "command" as const;
export const throughSchema = z.literal(THROUGH_THE_COMMAND);
export type Through = z.infer<typeof throughSchema>;
