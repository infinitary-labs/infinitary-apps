import { z } from "zod";
import { machineLoginOutcomeSchema } from "./accounts";
import { CUT_OFF_CLASSES } from "./authFailure";
import { deviceKindSchema, foundToolsSchema } from "./devices";
import { emoteWords, FIRSTMATE_EMOTES } from "./emotes";
import { lastTurnEligibilitySchema } from "./lastTurn";
import { slotSchema } from "./modelSlots";
import {
  remoteLoginCopySchema,
  remoteLoginDoingSchema,
  remoteLoginStageSchema,
} from "./remoteLogin";
import { repoDeliverySchema, repoSetupKindSchema } from "./repos";
import { rigorSchema } from "./rigor";
import { workPostureSchema } from "./workPosture";

/**
 * The normalized crewmate event union. Pi's raw events never cross IPC
 * (docs/architecture.md section 4): the main process narrows them to this
 * schema first, defensively (`unknown` in, narrow out).
 */

/**
 * Where a turn's `cost` came from (docs/usage.md): `listed-prices` is the
 * model's own per-category rates as the session priced the turn, `claude`
 * is Claude's estimate for the turn, `reported` is the cost the provider's
 * reply stated for the call. A cost the session could not price is absent,
 * never zero.
 */
export const usageCostSourceSchema = z.enum(["listed-prices", "claude", "reported"]);
export type UsageCostSource = z.infer<typeof usageCostSourceSchema>;

const usageCountsSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  /** Reported thinking tokens, already included in output; never add to totals. */
  reasoning: z.number().optional(),
  cost: z.number().optional(),
  /** The estimate by token category, where the session priced each one apart. */
  costParts: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  costSource: usageCostSourceSchema.optional(),
});

export const usageSchema = usageCountsSchema.extend({
  /**
   * Each model that served the turn, with its own share, when the session
   * names them (Claude does: a turn can call several). The counts above are
   * their sum.
   */
  models: z.array(usageCountsSchema.extend({ model: z.string().min(1) })).optional(),
});
export type FmUsage = z.infer<typeof usageSchema>;
export type FmModelUsage = NonNullable<FmUsage["models"]>[number];

export const cutOffSchema = z.object({
  class: z.enum(CUT_OFF_CLASSES),
  resetsAt: z.number().optional(),
});

/**
 * The progress a transport shows as a tool the model never called: context
 * compaction and a provider retry. They ride tool_start / tool_end so the
 * shell can show progress, and are never one of the model's tool calls.
 */
export const PROGRESS_TOOL_NAMES = ["compact_context", "retry"] as const;

export function isProgressTool(toolName: string): boolean {
  return (PROGRESS_TOOL_NAMES as readonly string[]).includes(toolName);
}

/**
 * What a failed turn says when its backend gave no words of its own. One
 * wording, so a replayed failure reads exactly as a live one.
 */
export const UNSTATED_TURN_ERROR = "The provider returned an error.";

export const taskStatusSchema = z.enum(["completed", "cancelled", "failed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * A run of feed lines that are one line (`feedRunOf`): the run's first event
 * writes its line, and each later event of the same run rewrites that line in
 * place - its words and time - while it is still Activity's newest; once any
 * other line enters Activity, the run's next event writes a new line.
 * `withdrawn` takes the line away.
 */
export const feedRunSchema = z.object({ id: z.string(), withdrawn: z.boolean().optional() });

export const fmEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task_started"),
    taskId: z.string(),
    title: z.string(),
    machineId: z.string(),
    crewmate: z.string(),
  }),
  z.object({ type: z.literal("assistant_delta"), taskId: z.string(), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), taskId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("tool_start"),
    taskId: z.string(),
    callId: z.string(),
    toolName: z.string(),
  }),
  z.object({
    type: z.literal("tool_end"),
    taskId: z.string(),
    callId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    /** Usage reported by model-powered tool work, separate from a conversational turn. */
    usage: usageSchema.optional(),
  }),
  z.object({ type: z.literal("turn_end"), taskId: z.string(), usage: usageSchema.optional() }),
  /**
   * A turn that ended in a provider error (Pi resolves these instead of
   * throwing, so without this event the failure would be invisible). The
   * supervisor enriches crewmate ones with the crewmate name and task title.
   */
  z.object({
    type: z.literal("turn_failed"),
    taskId: z.string(),
    error: z.string(),
    /**
     * The typed cut-off behind the failure, when the backend reported one
     * in its own fields (docs/quota.md "Typed cut-offs"). Absent on an
     * ordinary failure, and on every failure from a backend that reports
     * prose only.
     */
    cutOff: cutOffSchema.optional(),
    /** The backend exhausted its own context-length recovery. */
    contextOverflow: z.literal(true).optional(),
    /**
     * The Firstmate's seat paused on this cut-off: its pause line and card
     * speak for the failure. Absent when the cut-off paused nothing (a
     * spent allowance with no known reset), which is an ordinary failure.
     */
    paused: z.boolean().optional(),
    crewmate: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_finished"),
    taskId: z.string(),
    status: taskStatusSchema,
    error: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_report"),
    taskId: z.string(),
    title: z.string(),
    crewmate: z.string(),
    /** First sentence of the report, capped, for the feed line. */
    summary: z.string().optional(),
  }),
  /** A finished task's branch was merged locally (Q5, forge-agnostic). */
  z.object({
    type: z.literal("task_landed"),
    taskId: z.string(),
    title: z.string(),
    mode: z.enum(["fast-forward", "merge"]),
  }),
  z.object({ type: z.literal("auth_reconnect_required"), providerId: z.string() }),
  /** The fleet changed (agent-operated); display surfaces refresh on these. */
  z.object({
    type: z.literal("repo_setup"),
    actor: z.enum(["captain", "firstmate"]).optional(),
    repoId: z.string(),
    name: z.string(),
    path: z.string(),
    kind: repoSetupKindSchema,
  }),
  z.object({
    type: z.literal("repo_configured"),
    /** Exact name, folder or approved address change, when one changed. */
    description: z.string().optional(),
    actor: z.enum(["captain", "firstmate"]).optional(),
    repoId: z.string(),
    name: z.string(),
    delivery: repoDeliverySchema,
    autonomy: z.boolean(),
    /** The standing rigor the repository now declares; null = derived (phase 3). */
    rigor: rigorSchema.nullable(),
  }),
  z.object({
    type: z.literal("repo_unregistered"),
    actor: z.enum(["captain", "firstmate"]).optional(),
    repoId: z.string(),
    name: z.string(),
  }),
  /**
   * A project's Runs on changed (docs/helper.md, "Runs on"): where its next
   * task starts, a computer that runs work by its id or null for this Mac.
   * `text` is the whole feed line, in the design skill's words.
   */
  z.object({
    type: z.literal("repo_runs_on"),
    actor: z.enum(["captain", "firstmate"]).optional(),
    repoId: z.string(),
    name: z.string(),
    runsOn: z.string().nullable(),
    text: z.string(),
  }),
  /**
   * A device used its link and is on the home's list (docs/devices.md).
   * `name` is the device's own words, drawn as text; nothing of the link
   * rides it. A computer that runs work adds the macOS user it runs as,
   * whether it is another user on this Mac, and what it said it has there.
   * `again`: a device already on the list used the link to find this Mac
   * where it is now, and stays as it was (docs/devices.md, "Finding the
   * home again").
   */
  z.object({
    type: z.literal("device_joined"),
    deviceId: z.string(),
    name: z.string(),
    kind: deviceKindSchema,
    user: z.string().optional(),
    onThisMac: z.boolean().optional(),
    found: foundToolsSchema.optional(),
    again: z.boolean().optional(),
    /** Where it reached this computer, when the socket says. */
    reachedOn: z.enum(["local", "private"]).optional(),
  }),
  /**
   * A step of adding a Mac by its address, updating Firstmate there, or
   * removing what Firstmate set up there, over Remote Login (docs/devices.md,
   * "Adding a computer by its address"). `text` is the whole feed line, in the
   * design skill's words; a refusal is two of them, each `warn`. `stage`
   * and `deviceId` are typed facts Settings -> Devices follows; nothing of a
   * link rides it.
   */
  z.object({
    type: z.literal("device_setup"),
    address: z.string(),
    doing: remoteLoginDoingSchema,
    stage: remoteLoginStageSchema,
    /** The other Mac's own name, once the home heard it. */
    name: z.string().optional(),
    deviceId: z.string().optional(),
    text: z.string(),
    tone: z.enum(["info", "warn"]),
    /** How far the copy of Firstmate has gone there, while it is set up or found again. */
    copy: remoteLoginCopySchema.optional(),
    /**
     * The run of lines this one belongs to (`feedRunSchema`): each later
     * count of the copy sent so far rewrites the line before it.
     */
    run: feedRunSchema.optional(),
  }),
  /**
   * A change in this Mac's own SSH connection to a computer it added by its
   * address, said once (docs/devices.md, "Through the home's SSH"): it
   * stopped trying until Try again, came back after that, the work there
   * could not start, or this Mac gave up removing what it set up on one it
   * removed. Nothing secret rides it.
   */
  z.object({
    type: z.literal("device_connection"),
    deviceId: z.string(),
    name: z.string(),
    state: z.enum(["stopped", "connected", "not-started", "gave-up"]),
    text: z.string(),
    tone: z.enum(["info", "warn"]),
  }),
  /**
   * One step of updating Firstmate on a computer that runs work over the
   * connection (docs/devices.md, "Updating over the connection"): what the
   * feed says, and each refusal's two `warn` lines. Nothing secret rides it.
   */
  z.object({
    type: z.literal("device_update"),
    deviceId: z.string(),
    name: z.string(),
    stage: z.enum(["updating", "done", "refused"]),
    text: z.string(),
    tone: z.enum(["info", "warn"]),
    /**
     * How far Firstmate has gone there (docs/devices.md, "Downloading over
     * the connection"): its download's count, this computer's send's, or
     * starting it again.
     */
    copy: remoteLoginCopySchema.optional(),
    /** The run of lines this one belongs to (`feedRunSchema`): each later count rewrites the line before it. */
    run: feedRunSchema.optional(),
  }),
  /**
   * A device's person chose Leave on it, and it is off the home's list
   * (docs/devices.md, "Leave"). `name` is the device's own words.
   */
  z.object({
    type: z.literal("device_left"),
    deviceId: z.string(),
    name: z.string(),
    kind: deviceKindSchema,
  }),
  /**
   * A computer that runs work signed in to one of its own subscriptions
   * (docs/helper.md, "Its own sign-ins"). `who` is how the home names it -
   * its own name, or the macOS user it runs as here - and `provider` the
   * subscription's name; nothing the captain typed rides it.
   */
  z.object({
    type: z.literal("device_signed_in"),
    deviceId: z.string(),
    who: z.string(),
    provider: z.string(),
  }),
  /**
   * The captain signed a computer that runs work out of one of its own
   * subscriptions (Disconnect). For Claude, `login` is what became of that
   * computer's own Claude login: signed out when Firstmate made it there
   * from a pasted code, kept when it did not; absent when the computer did
   * not say.
   */
  z.object({
    type: z.literal("device_signed_out"),
    deviceId: z.string(),
    who: z.string(),
    provider: z.string(),
    login: machineLoginOutcomeSchema.optional(),
  }),
  /**
   * A short FYI line from the Firstmate agent for the activity feed. One
   * that names its task is a row on that task's record, which the feed
   * reads back (docs/task-record.md, "What Activity holds"), so it never
   * reaches a client as itself.
   */
  z.object({ type: z.literal("firstmate_note"), text: z.string(), taskId: z.string().optional() }),
  /**
   * A character reaction, drained by the character renderer: one the
   * Firstmate asked for with its emote tool, or a reply emote the host fired
   * for a captain turn's steer (nod), note (tuck) or personalize (tick).
   * `text` is the emote's few words, already clean by the shared rule
   * (`emoteWords`): the Firstmate's own, or on a reply the host fired the
   * app's own words (`AUTOMATIC_EMOTE_WORDS`), marked `automatic`. The
   * window shows them only as the turn's reply line, which the core chooses
   * and sends as `firstmate_reply`.
   */
  z.object({
    type: z.literal("firstmate_emote"),
    emote: z.enum(FIRSTMATE_EMOTES),
    text: z
      .string()
      .refine((text) => {
        const words = emoteWords(text);
        return words.kind === "words" && words.text === text;
      }, "emote words must be clean and at most EMOTE_WORDS_MAX characters")
      .optional(),
    automatic: z.literal(true).optional(),
  }),
  /**
   * A durable note was written (create/revise/retire/restore). The text is
   * the feed body after "noted - "; the word memory never reaches the UI.
   */
  z.object({ type: z.literal("memory_noted"), text: z.string() }),
  /**
   * The Firstmate applied a preference on the captain's word (talk-to-
   * personalize Step 1: theme, a panel's rail or visibility, a surface
   * removed, a standing instruction). One feed line, never a card; the
   * text is the whole line. Catalog actions stamp their actor; older events
   * without one retain the Firstmate personalization wording.
   */
  z.object({
    type: z.literal("personalized"),
    text: z.string(),
    actor: z.enum(["captain", "firstmate"]).optional(),
    /**
     * The captain's settled run this line belongs to (docs/orchestrator-contract.md,
     * "Settled runs"): a later step of the same run rewrites the run's line
     * in place while it is still Activity's newest, and `withdrawn` takes
     * the line away because the run came back where it started.
     */
    run: feedRunSchema.optional(),
  }),
  /**
   * A closed card was brought forward as a read-only past card (FI3-579
   * piece 4, `inf:cards:show-past`). The shell opens its held entry; nothing
   * is stored and no card is raised.
   */
  z.object({ type: z.literal("past_card_shown"), cardId: z.string() }),
  /**
   * A card still on the stack was brought to its front (What's new,
   * `inf:release-notes:show`). The shell shows it; nothing is stored.
   */
  z.object({ type: z.literal("open_card_shown"), cardId: z.string() }),
  /**
   * A task's own browser changed for the captain (docs/task-browser.md, "The
   * view"): it opened, moved, acted or stopped. Per-task invalidation for
   * `tasks.detail`, which carries its fact; nothing is stored or shown.
   */
  z.object({ type: z.literal("task_browser"), taskId: z.string() }),
  /**
   * A write changed knowledge (docs/knowledge.md, "The browser"), or the
   * purge cleared it. Invalidation for the browser's reads; nothing is
   * stored or shown, and only an alpha or development build sends it.
   */
  z.object({ type: z.literal("knowledge_changed") }),
  /** The captain submitted a home-input turn (text and/or images). */
  z.object({ type: z.literal("user_turn"), text: z.string() }),
  /**
   * The Firstmate's reply line to the captain's last message, sent as the
   * turn that read it ends and before its busy signal falls (src/shared/
   * lastTurn.ts, docs/composer.md "The last turn"); the same line is kept
   * beside the message for the next launch.
   */
  z.object({
    type: z.literal("firstmate_reply"),
    text: z.string(),
    problem: z.boolean().optional(),
    /** Typed completion: absent is unknown, and the line stays. */
    eligibility: lastTurnEligibilitySchema.optional(),
  }),
  /**
   * A task record changed (task-system P3): per-task invalidation for
   * `tasks.detail`. `seq` is the board sequence the change committed
   * under, the same one the next `inf:tasks` push carries. Emitted after
   * the commit, never from memory.
   */
  z.object({
    type: z.literal("task_changed"),
    taskId: z.string(),
    key: z.string(),
    kind: z.enum(["work", "question", "decision", "operation"]),
    status: z.enum(["open", "active", "done", "dropped"]),
    /**
     * The status the record carried before this change, as the emitter
     * last saw it; null for a row it had not seen. A status transition is
     * `from !== status` - the one thing a reaction (the character's emote,
     * P5) may key on, so a later write on a closed row never re-fires it.
     */
    from: z.enum(["open", "active", "done", "dropped"]).nullable(),
    activity: z.enum(["starting", "running", "idle", "interrupted"]).nullable(),
    workPosture: workPostureSchema.optional(),
    /**
     * A work task's served slot as the board reads it (`TaskView.tier`),
     * so the crew orbit can paint the crewmate's solid; null when it never
     * routed. Absent on a non-work row.
     */
    tier: slotSchema.nullable().optional(),
    /** Builder id only for a host-commissioned review; null on other work. */
    reviewOf: z.string().nullable().optional(),
    /** Actual task placement, not the project's current Runs on. */
    executionDeviceId: z.string().nullable().optional(),
    closedReason: z
      .enum([
        "landed",
        "merged",
        "released",
        "answered",
        "settled",
        "finished",
        "cancelled",
        "discarded",
        "failed",
        "superseded",
      ])
      .nullable(),
    seq: z.number(),
  }),
  /**
   * A timeline event landed on a task (task-system P3): the feed's source.
   * `text` is the feed-ready line the core authored from the event and its
   * record (src/core/tasks/taskFeed.ts), `feed` whether it belongs in the
   * global feed (a crewmate's own progress notes do not).
   */
  z.object({
    type: z.literal("task_event"),
    taskId: z.string(),
    key: z.string(),
    kind: z.string(),
    text: z.string(),
    at: z.number(),
    feed: z.boolean(),
  }),
  /** The Firstmate agent's own busy state (drives the thinking phase). */
  z.object({ type: z.literal("firstmate_state"), busy: z.boolean() }),
  /** Live crew strip counts: runtimes plus queued work. */
  z.object({
    type: z.literal("crew_counts"),
    working: z.number(),
    idle: z.number(),
    queued: z.number(),
  }),
]);
export type FmEvent = z.infer<typeof fmEventSchema>;

export const crewCountsSchema = z.object({
  working: z.number(),
  idle: z.number(),
  queued: z.number(),
});
export type CrewCounts = z.infer<typeof crewCountsSchema>;
