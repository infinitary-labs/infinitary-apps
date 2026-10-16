import { z } from "zod";
import { deviceJoinedLine } from "./devices";
import type { FmEvent } from "./events";
import { FIRSTMATE_SESSION_ID } from "./observe";
import { plainProblem } from "./plainProblem";
import { withoutIntentLead } from "./rigor";
import { deviceSignedOutLine } from "./signIns";
import { taskEventKindSchema } from "./tasks";
import { AUTONOMY_WORDS, CARE_WORDS, DELIVERY_WORDS } from "./vocabulary";

/**
 * The one mapping from FmEvents to activity-feed lines, shared by the
 * renderer (live display) and main (persistence, P10) so the feed the user
 * sees and the feed that survives a restart can never drift apart.
 *
 * Since task-system P3 the feed is a VIEW over two tables: a task's own
 * timeline (`task_events` where feed = 1, authored into a line by
 * `src/core/tasks/taskFeed.ts` and carried live as the `task_event`
 * FmEvent) and the few task-less lines this mapping still persists into
 * `activity_events`. The task-bound cases this function used to author
 * (a spawn, a report, a landing, a decommission, a crewmate's failed turn)
 * left it with the events that now write the timeline; the feed line for
 * each is derived from the record, so it cannot disagree with it.
 */

export const feedLineSchema = z.object({
  // The kind supplies the activity line's semantic dot color and accessible label.
  kind: z.enum(["info", "ok", "warn", "danger", "you"]),
  text: z.string(),
  at: z.number(),
  /** The task the line is about, by key; a task-less line has none. */
  taskKey: z.string().optional(),
  /**
   * The timeline event a task line was authored from (`report`,
   * `dispatched`, `landed`, ...); a task-less line has none. A typed fact,
   * so a reader finds a line by what happened, never by its words.
   */
  event: taskEventKindSchema.optional(),
});
export type FeedLine = z.infer<typeof feedLineSchema>;

export { feedRelativeAge } from "./relativeAge";

/** The semantic trail a timeline event paints (shared by the core's authoring). */
export function taskFeedKind(kind: string, closedStatus?: string): FeedLine["kind"] {
  if (kind === "landed" || kind === "merged") return "ok";
  if (kind === "status" && closedStatus === "done") return "ok";
  if (kind === "failed") return "danger";
  if (kind === "status" && closedStatus === "dropped") return "warn";
  if (kind === "ci") return "warn";
  return "info";
}

/** Feed report bodies stay short. */
export const FEED_REPORT_LIMIT = 120;

/**
 * First sentence of a report, capped for the activity feed. A five-heading
 * report's Intent section restates the ask, so the sentence is taken after
 * it (`withoutIntentLead`).
 */
export function reportSummary(text: string, limit = FEED_REPORT_LIMIT): string {
  const collapsed = withoutIntentLead(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const sentence = collapsed.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? collapsed;
  return sentence.length <= limit ? sentence : sentence.slice(0, limit).trimEnd();
}

export function feedLineFrom(event: FmEvent): Omit<FeedLine, "at"> | null {
  switch (event.type) {
    case "task_event":
      // Already authored by the core from the record; the line is in
      // task_events, so the persistence seam must not record it again.
      return event.feed
        ? { kind: taskFeedKind(event.kind), text: event.text, taskKey: event.key }
        : null;
    case "firstmate_note":
      // The captain's call: show the note's own words. Activity and the
      // whisper paint this text as saved; lines already stored keep the
      // old prefix until retention drops them.
      return { kind: "info", text: event.text };
    case "memory_noted":
      return { kind: "info", text: `First mate · remembered: ${event.text}` };
    case "personalized":
      // A settled run that came back where it started leaves no line.
      if (event.run?.withdrawn) return null;
      // Tier A of talk-to-personalize: the change is the line, no card.
      return {
        kind: "info",
        text: event.actor
          ? `${event.actor === "captain" ? "Captain" : "First mate"} · ${event.text}`
          : `First mate · personalized: ${event.text}`,
      };
    case "user_turn": {
      const preview = reportSummary(event.text);
      return { kind: "you", text: preview ? `Captain: ${preview}` : "Captain: image" };
    }
    case "repo_setup":
      return {
        kind: "info",
        text: `${event.actor === "captain" ? "Captain · " : event.actor === "firstmate" ? "First mate · " : ""}Project ${event.name} · ${
          event.kind === "clone" ? "cloned" : event.kind === "init" ? "created" : "linked"
        }`,
      };
    case "repo_configured":
      // The standing rigor is named only when the repository declares one
      // (delivery rigor phase 3); a derived rigor is the default and says
      // nothing here.
      return {
        kind: "info",
        text:
          event.description ??
          `${event.actor ? `${event.actor === "captain" ? "Captain" : "First mate"} · ` : ""}Project ${event.name} · settings: ${DELIVERY_WORDS[event.delivery] ?? event.delivery}, ${(
            event.autonomy ? AUTONOMY_WORDS.putsInItself : AUTONOMY_WORDS.asksFirst
          ).toLowerCase()}${event.rigor ? `, care: ${CARE_WORDS[event.rigor] ?? event.rigor}` : ""}`,
      };
    case "repo_runs_on":
      return { kind: "info", text: event.text };
    case "repo_unregistered":
      return {
        kind: "info",
        text: `${event.actor === "captain" ? "Captain · " : event.actor === "firstmate" ? "First mate · " : ""}Project ${event.name} · removed`,
      };
    case "device_joined":
      return { kind: "info", text: deviceJoinedLine(event) };
    case "device_setup":
    case "device_update":
    case "device_connection":
      return { kind: event.tone, text: event.text };
    case "device_left":
      return { kind: "info", text: `${event.name} left.` };
    case "device_signed_in":
      return { kind: "info", text: `${event.who} is signed in to ${event.provider}.` };
    case "device_signed_out":
      return deviceSignedOutLine(event);
    case "turn_failed": {
      // The Firstmate's own failed turn has no task record, so it is the one
      // failed turn still authored here; a crewmate's lands on its timeline
      // (`failed` event) and reaches the feed as a task_event.
      // The raw error stays on the Firstmate's failure card and in Observe;
      // the feed says what it means (the vocabulary's error row).
      if (event.taskId !== FIRSTMATE_SESSION_ID) return null;
      // A cut-off the seat paused on is a designed path, not a problem: the
      // seat's own line says what stopped it and what is kept ("Firstmate
      // paused: ..."). One that paused nothing is an ordinary failure.
      if (event.paused) return null;
      return { kind: "danger", text: `First mate · problem: ${plainProblem(event.error)}` };
    }
    default:
      return null;
  }
}

/**
 * The run of lines an event's line belongs to, when it declares one
 * (`feedRunSchema`): the captain's settled run on one setting
 * (docs/orchestrator-contract.md, "Settled runs"), or a copy's count of what
 * it sent so far (docs/devices.md, "How far the copy has gone").
 */
export function feedRunOf(event: FmEvent): { id: string; withdrawn?: boolean } | undefined {
  return event.type === "personalized" || event.type === "device_setup" ? event.run : undefined;
}

/**
 * Whether an event changes what Activity holds: a line written or rewritten
 * in place (`feedLineFrom`), or a run's line withdrawn
 * (docs/orchestrator-contract.md, "Settled runs").
 */
export function changesFeed(event: FmEvent): boolean {
  return feedLineFrom(event) !== null || feedRunOf(event)?.withdrawn === true;
}
