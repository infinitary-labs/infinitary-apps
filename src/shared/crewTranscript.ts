import { z } from "zod";
import { planItemStateSchema } from "./taskPlan";

/**
 * The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate tab"):
 * the crewmate's own session read as a CLI agent's transcript, in Claude
 * Code's shape - the captain's choice on FI3-1419 - with a composer under it
 * whose line is a captain steer on the crewmate's own lane.
 *
 * The transcript is read, never stored: the core builds it at each read from
 * the sessions the app keeps for the task, through the one session reader,
 * and from the task's own record for who sent each line it was told. What it
 * never carries: the crewmate's thinking, a system prompt, sign-ins, usage or
 * token counts. Every string in it is redacted as an Observe line is.
 */

/** The tab's name on the strip: the captain's own word for it. */
export const CREWMATE_TAB_LABEL = "Crewmate";

/** How much of a tool's result its fold opens to. */
export const CREW_RESULT_TEXT_MAX = 8_000;
/** How much of a longer text a line carries: the crewmate's words, a report, a line it was sent. */
export const CREW_TEXT_MAX = 20_000;
/** The longest a call's target or description reads; a longer one ends in an ellipsis. */
export const CREW_CALL_TEXT_MAX = 160;
/** The most lines one transcript carries; the earlier ones are counted, not sent. */
export const CREW_TRANSCRIPT_LINES_MAX = 1_500;
/** The most lines of a diff a line carries; the rest are counted. */
export const CREW_DIFF_LINES_MAX = 80;

/**
 * A picture a tool's result holds, by where it sits in the crewmate's
 * sessions; the picture itself is read on its own when shown
 * (`inf:tasks:crewmate:picture`), never carried in the transcript.
 */
export const crewPictureRefSchema = z.object({
  ref: z.string(),
  mimeType: z.string(),
});
export type CrewPictureRef = z.infer<typeof crewPictureRefSchema>;

/** A result's whole text, read when its fold opens: cut at `CREW_RESULT_TEXT_MAX`. */
export const crewResultTextSchema = z.object({
  text: z.string(),
  /** How many characters past the cut were left out. */
  cut: z.number().int().nonnegative(),
});
export type CrewResultText = z.infer<typeof crewResultTextSchema>;

/** One picture, read: its type and its bytes as base64. */
export const crewPictureSchema = z.object({
  mimeType: z.string(),
  data: z.string(),
});
export type CrewPicture = z.infer<typeof crewPictureSchema>;

/**
 * What a tool call answered, folded under its call to a count. The whole
 * text is read on its own when the fold opens (`inf:tasks:crewmate:result`),
 * so a long session's transcript stays small.
 */
export const crewResultSchema = z.object({
  /** Where the result sits in the crewmate's sessions, to read its whole text. */
  ref: z.string(),
  /** How many lines the whole result held. */
  lines: z.number().int().nonnegative(),
  /** Its first line, cut at `CREW_CALL_TEXT_MAX`. */
  preview: z.string(),
  error: z.boolean(),
  pictures: z.array(crewPictureRefSchema),
});
export type CrewResult = z.infer<typeof crewResultSchema>;

/** One line of a diff: kept for context, removed, or added. */
export const crewDiffLineSchema = z.object({
  kind: z.enum(["context", "removed", "added", "gap"]),
  text: z.string(),
});
export type CrewDiffLine = z.infer<typeof crewDiffLineSchema>;

/** What an edit or a write changed, drawn from the call's own arguments. */
export const crewDiffSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  lines: z.array(crewDiffLineSchema),
  /** Lines past `CREW_DIFF_LINES_MAX`, left out. */
  more: z.number().int().nonnegative(),
});
export type CrewDiff = z.infer<typeof crewDiffSchema>;

/** Who sent a line the crewmate was told: the captain, Firstmate, or the app itself. */
export const crewSenderSchema = z.enum(["captain", "firstmate", "app"]);
export type CrewSender = z.infer<typeof crewSenderSchema>;

const line = { id: z.string(), at: z.number() };

export const crewLineSchema = z.discriminatedUnion("kind", [
  /** The brief the crewmate ran from, folded to one line. */
  z.object({ kind: z.literal("brief"), ...line, text: z.string() }),
  /** The crewmate's own words. */
  z.object({ kind: z.literal("said"), ...line, text: z.string() }),
  /**
   * A call to a tool, in two lines: the tool, its target and the line the
   * crewmate wrote to say what it does; then its result, folded. Null
   * while the call has not answered.
   */
  z.object({
    kind: z.literal("tool"),
    ...line,
    name: z.string(),
    /** The call's main argument in one line: a path in the working copy, a command, a page. */
    target: z.string(),
    /** The one line the crewmate wrote with the call, or a plain reading when it wrote none. */
    reading: z.string(),
    result: crewResultSchema.nullable(),
    /** What an edit or a write changed, from its arguments. */
    diff: crewDiffSchema.optional(),
  }),
  /** A line the crewmate was told, and by whom; queued until its session holds it. */
  z.object({
    kind: z.literal("sent"),
    ...line,
    from: crewSenderSchema,
    text: z.string(),
    queued: z.boolean(),
    /** How the captain sent it: typed here, or replied under a card. */
    via: z.enum(["crewmate-tab", "thread", "other"]).optional(),
  }),
  /** The plan it reported with a progress note. */
  z.object({
    kind: z.literal("plan"),
    ...line,
    text: z.string(),
    items: z.array(z.object({ label: z.string(), state: planItemStateSchema })),
  }),
  /** A report, its headline and its whole text. */
  z.object({ kind: z.literal("report"), ...line, summary: z.string(), text: z.string() }),
  /** A card it put up; its id when the call named one. */
  z.object({
    kind: z.literal("card"),
    ...line,
    title: z.string(),
    cardId: z.string().nullable(),
  }),
  /** The pull request it opened. */
  z.object({ kind: z.literal("change"), ...line, title: z.string() }),
  /** A turn someone stopped before it finished, and who. */
  z.object({ kind: z.literal("stopped"), ...line, by: crewSenderSchema }),
  /** Its conversation was shortened to fit. */
  z.object({ kind: z.literal("compacted"), ...line }),
  /** A turn the model could not finish, in its error's words. */
  z.object({ kind: z.literal("failed"), ...line, text: z.string() }),
]);
export type CrewLine = z.infer<typeof crewLineSchema>;
export type CrewLineKind = CrewLine["kind"];

export const crewTranscriptSchema = z.object({
  taskId: z.string(),
  /** Lines before the first one carried, left out past `CREW_TRANSCRIPT_LINES_MAX`. */
  earlier: z.number().int().nonnegative(),
  lines: z.array(crewLineSchema),
  /** Moves whenever the lines do, so a re-read that says the same thing is not delivered again. */
  revision: z.string(),
});
export type CrewTranscript = z.infer<typeof crewTranscriptSchema>;

/** The transcript of a task no crewmate has a session for yet. */
export const emptyTranscript = (taskId: string): CrewTranscript => ({
  taskId,
  earlier: 0,
  lines: [],
  revision: "",
});

/** The crewmate's running turn, which its session does not hold yet. */
export const crewLiveSchema = z.object({
  taskId: z.string(),
  /** What it is writing now. */
  text: z.string(),
  /** When its running turn began; null while none runs. */
  since: z.number().nullable(),
});
export type CrewLive = z.infer<typeof crewLiveSchema>;

/** What a line typed in the Crewmate tab answers: on its way, or refused in words. */
export const crewSendResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), text: z.string() }),
]);
export type CrewSendResult = z.infer<typeof crewSendResultSchema>;

/** The tab's words, owned here so the window and its journeys read the same ones. */
export const CREWMATE_WORDS = {
  /** The composer's placeholder while a turn runs, and while none does. */
  placeholderWorking: "Tell the crewmate something; it hears it at its next step",
  placeholderIdle: "Tell the crewmate what to do next",
  /** The composer's field, by its accessible name. */
  field: "Message to the crewmate",
  /** Beside the field: where Enter sends it. */
  sendsTo: "to the crewmate",
  /** A typed line the crewmate's session does not hold yet. */
  queued: "queued",
  /** The status line's words for each state. */
  working: "Working…",
  interruptHint: "to interrupt",
  stop: "Stop",
  stopping: "Stopping…",
  idle: "Idle",
  waiting: "Waiting on you",
  paused: "Paused · you hold its browser",
  closed: "This task is closed; its session reads as it ran.",
  /** No session to read yet. */
  empty: "Nothing yet: the crewmate's session starts when it does.",
  unreadable: "This crewmate's session could not be read.",
  /** A fold's buttons. */
  open: "open",
  fold: "fold",
  /** The brief's line. */
  brief: "The brief",
  /** Labels for a line someone else sent. */
  firstmate: "First mate",
  app: "From the app",
  /** A call that has not answered: still running, or never answered; one that answered nothing. */
  running: "running…",
  noResult: "no result",
  noOutput: "no output",
  /** What a fold opens to past its first line. */
  moreLines: (count: number) => `+${count} ${count === 1 ? "line" : "lines"}`,
  cut: (count: number) => `${count} more characters are not shown.`,
  /** A picture a call's result holds: shown small, larger on a press. */
  picture: "A picture the crewmate's call answered with",
  pictureLarger: "Show larger",
  pictureSmaller: "Show smaller",
  /** Who stopped a turn. */
  stopped: {
    captain: "You stopped its turn.",
    firstmate: "Your first mate stopped its turn.",
    app: "Its turn was stopped.",
  },
  failed: "Its turn failed:",
  /** Blocks' labels. */
  plan: "Plan",
  progress: "Progress",
  report: "Report",
  card: "Card",
  showCard: "Show the card",
  change: "Pull request",
  compacted: "Its conversation was shortened to fit.",
  earlier: (count: number) =>
    `${count} earlier ${count === 1 ? "line is" : "lines are"} not shown.`,
} as const;

/** A result's fold, as the line under its call reads it. */
export function resultCountWords(result: CrewResult): string {
  const lines = `${result.lines} ${result.lines === 1 ? "line" : "lines"}`;
  return result.error ? `Error · ${lines}` : lines;
}

/** A diff's summary, as the line under an edit reads it. */
export function diffWords(diff: CrewDiff): string {
  const added = diff.added > 0 ? `Added ${diff.added} ${diff.added === 1 ? "line" : "lines"}` : "";
  const removed =
    diff.removed > 0 ? `removed ${diff.removed} ${diff.removed === 1 ? "line" : "lines"}` : "";
  if (added && removed) return `${added}, ${removed}`;
  if (added) return added;
  if (removed) return `${removed.charAt(0).toUpperCase()}${removed.slice(1)}`;
  return "No change";
}

/** A running turn's age, as the status line reads it: `12s`, `4m 05s`, `1h 02m`. */
export function elapsedWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
