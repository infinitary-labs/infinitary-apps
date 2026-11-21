import { z } from "zod";

/**
 * The first launch (captain decisions 2026-09-19; docs/first-launch.md).
 *
 * Nothing here is a first-run FLAG. The gate - the stage saying "connect a
 * subscription to begin" with the input disabled - is derived from the same
 * model pool the Firstmate's own pre-flight reads: it is open exactly while
 * no model could answer the Firstmate, on a fresh install and again if the last
 * such account is ever removed. The record remembers only moments that
 * happen once: committed welcome creation, the captain's first turn, which
 * ends the first-run placeholder, each crewmate state word taught, the
 * first task of the captain's that finished, the third of their
 * crewmates that finished, and their first crewmate's start. Delivery eligibility is durable; it never
 * substitutes for the derived gate.
 */
export const firstRunRecordSchema = z.object({
  /** New profiles: committed welcome creation. Legacy values recorded wake scheduling, not viewing. */
  welcomedAt: z.number().nullable(),
  /** Durable delivery eligibility; absent on legacy profiles, which are skipped. */
  welcomeState: z.enum(["uninitialized", "pending", "skipped", "consumed"]).optional(),
  /** Identity of the once-only introduction, retained after dismissal or cleanup. */
  welcomeCardId: z.string().optional(),
  /** When the captain's first turn was accepted; null = not yet. */
  firstTurnAt: z.number().nullable(),
  /**
   * When each crewmate state word ("Working", "Idle") was shown in full to a
   * new person (docs/first-launch.md "The crewmate's state words"); null =
   * not yet taught. Absent until the core first reads the record, which marks
   * a profile that already has crew history as taught.
   */
  workingWordAt: z.number().nullable().optional(),
  idleWordAt: z.number().nullable().optional(),
  /**
   * When a task of the captain's first closed done; absent = not yet.
   * Recorded once, at the first read that finds one, never cleared. Nothing
   * in this version reads it: it stays for a view on an older version,
   * which still shows the create-your-own-panel slot from it.
   */
  firstTaskDoneAt: z.number().optional(),
  /**
   * When the third of the captain's crewmates finished its task, which
   * shows the create-your-own-panel slot (docs/first-launch.md); absent =
   * not yet. Recorded once, at the first read that finds three, never cleared.
   */
  thirdCrewmateDoneAt: z.number().optional(),
  /**
   * When a new person's first crewmate started (docs/first-launch.md "The
   * first crewmate's note"); null = not yet. Absent until the core first
   * reads the record, which marks a profile that already has crew history
   * as past it. Recorded once, at that first start, never cleared.
   */
  firstCrewmateAt: z.number().nullable().optional(),
  /** The note that start presented, when the profile had the welcome; kept after it is put away. */
  firstCrewmateNoteId: z.string().optional(),
});
export type FirstRunRecord = z.infer<typeof firstRunRecordSchema>;

export const EMPTY_FIRST_RUN: FirstRunRecord = { welcomedAt: null, firstTurnAt: null };

/**
 * The custom connection the Firstmate was chosen on, while the gate is open
 * only because its saved checks no longer count - checks an earlier version
 * made (docs/saved-data-compatibility.md). The gate names it and asks for its
 * one fresh check in place, instead of a subscription.
 */
export const freshCheckSchema = z.object({
  accountId: z.string(),
  label: z.string(),
  /** The models the fresh check covers, in the connection's order. */
  models: z.array(z.string()),
});
export type FreshCheck = z.infer<typeof freshCheckSchema>;

export const firstRunViewSchema = firstRunRecordSchema.extend({
  /** True while no model can answer the Firstmate: the stage carries the gate. */
  gateOpen: z.boolean(),
  /** Only while the gate is open: the connection whose fresh check would close it. */
  freshCheck: freshCheckSchema.optional(),
});
export type FirstRunView = z.infer<typeof firstRunViewSchema>;

/** The two crewmate colors that carry a taught word. */
export const crewWordSchema = z.enum(["working", "idle"]);
export type CrewWord = z.infer<typeof crewWordSchema>;

/**
 * The input's three placeholder states (design skill `VoiceInput`): the
 * standard hint; the first-run hint from the bind until the first captain
 * turn ("give your first mate a task" is the frame, and "give" is not "chat"); and
 * the gated line while the pill is disabled.
 */
export const STANDARD_PLACEHOLDER = "type, or press/hold right ⌥ to talk";
export const STANDARD_PLACEHOLDER_NO_VOICE = "type a task for a crewmate";
export const FIRST_RUN_PLACEHOLDER = "give your first mate a task, or press/hold right ⌥ to talk";
export const FIRST_RUN_PLACEHOLDER_NO_VOICE = "give your first mate a task";
export const GATED_PLACEHOLDER = "connect a subscription first";
/** The gated line while the gate asks for a connection's fresh check instead. */
export const GATED_CHECK_PLACEHOLDER = "check your connection first";

/**
 * The shorter forms an input too narrow for a hint's one line shows instead
 * (docs/composer.md). Each keeps what the empty box does not already say;
 * the first-run hint's is `FIRST_RUN_PLACEHOLDER_NO_VOICE`, its frame. The
 * gated line fits the disabled input whole, which has no Add files button.
 */
export const STANDARD_PLACEHOLDER_SHORT = "press/hold right ⌥ to talk";
export const STANDARD_PLACEHOLDER_NO_VOICE_SHORT = "type a task";
/**
 * The voice hint's shortest form, for an input its shorter form still
 * overflows because the key's name is longer than a Mac's glyph, as
 * Linux's "right Ctrl" is.
 */
export const STANDARD_PLACEHOLDER_SHORTEST = "hold right ⌥ to talk";
/**
 * The first-run hint's form for the same longer key name: at the default
 * window Linux's "give your first mate a task, or press/hold right Ctrl to
 * talk" is too wide, and this one keeps the key.
 */
export const FIRST_RUN_PLACEHOLDER_SHORT = "give your first mate a task, or hold right ⌥ to talk";

/**
 * A hint as this desktop shows it: the hints above name a Mac's default
 * dictation key, and the input names the key the person uses in its place,
 * in this desktop's words (`dictationKeyLabel`: "right Ctrl" on Linux).
 */
export function withDictationKey(hint: string, keyLabel: string): string {
  return hint.replace("right ⌥", keyLabel);
}

/** The first-run hint applies from the welcome until the first captain turn. */
export function isFirstRunHint(view: Pick<FirstRunView, "welcomedAt" | "firstTurnAt">): boolean {
  return view.welcomedAt !== null && view.firstTurnAt === null;
}
