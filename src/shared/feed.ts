import { cutText } from "@shared/textCut";
import { z } from "zod";
import { deviceJoinedLine } from "./devices";
import type { FmEvent } from "./events";
import { englishOf, type Said, type SaidPart, said, saidPart, saidSchema } from "./i18n/said";
import { FIRSTMATE_SESSION_ID } from "./observe";
import { plainProblem } from "./plainProblem";
import { withoutIntentLead } from "./rigor";
import { deviceSignedOutLine } from "./signIns";
import { taskEventKindSchema } from "./tasks";

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
  /**
   * The line is the first mate's computer's own words, so its "this
   * computer" (`HERE`) is that computer: a computer that controls it shows
   * the line naming that computer instead (`hereAs`; docs/view.md, "The
   * first mate's own words"). A line of the captain's or a crewmate's
   * words has none, and neither does one from a home built before it.
   */
  saidHere: z.literal(true).optional(),
  /**
   * The line as a fact, worded where it is shown (docs/i18n.md, "Saved
   * facts"); `text` is its English, for a reader that words nothing itself.
   * A line said as it was written, such as a crewmate's, has none.
   */
  said: saidSchema.optional(),
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
  return sentence.length <= limit ? sentence : cutText(sentence, limit).trimEnd();
}

/** Event types that can change Activity; also generates the native reader's refresh filter. */
export const FEED_EVENT_TYPES = [
  "task_event",
  "firstmate_note",
  "memory_noted",
  "personalized",
  "user_turn",
  "repo_setup",
  "repo_configured",
  "repo_runs_on",
  "repo_unregistered",
  "device_joined",
  "device_setup",
  "device_update",
  "device_connection",
  "device_left",
  "device_signed_in",
  "device_signed_out",
  "turn_failed",
] as const satisfies readonly FmEvent["type"][];

type FeedEvent = Extract<FmEvent, { type: (typeof FEED_EVENT_TYPES)[number] }>;
const feedTypes: ReadonlySet<string> = new Set(FEED_EVENT_TYPES);
function isFeedEvent(event: FmEvent): event is FeedEvent {
  return feedTypes.has(event.type);
}

/** Who set a project's fact, as a line's lead ("Captain · "); none when the app did. */
function byWho(actor: string | undefined, panel?: string): string | SaidPart {
  return actor === "captain"
    ? panel
      ? saidPart("feedByCaptainInPanel", { panel })
      : saidPart("feedByCaptain")
    : actor === "firstmate"
      ? saidPart("feedByFirstMate")
      : "";
}

const DELIVERY_SAID: Readonly<Record<string, SaidPart>> = {
  "direct-pr": saidPart("feedDeliveryPull"),
  "queue-pr": saidPart("feedDeliveryBatched"),
  "local-only": saidPart("feedDeliveryLocal"),
  "in-place": saidPart("feedDeliveryInPlace"),
};

const CARE_SAID: Readonly<Record<string, SaidPart>> = {
  quick: saidPart("feedCareQuick"),
  standard: saidPart("feedCareStandard"),
  reviewed: saidPart("feedCareReviewed"),
};

/** A line as its fact, with the fact's English as its text. */
function line(kind: FeedLine["kind"], fact: Said): Omit<FeedLine, "at"> {
  return { kind, text: englishOf(fact), said: fact };
}

export function feedLineFrom(event: FmEvent): Omit<FeedLine, "at"> | null {
  if (!isFeedEvent(event)) return null;
  switch (event.type) {
    case "task_event":
      // Already authored by the core from the record; the line is in
      // task_events, so the persistence seam must not record it again.
      return event.feed
        ? {
            kind: taskFeedKind(event.kind),
            text: event.text,
            taskKey: event.key,
            ...(event.said ? { said: event.said } : {}),
          }
        : null;
    case "firstmate_note":
      // The captain's call: show the note's own words. Activity and the
      // whisper paint this text as saved; lines already stored keep the
      // old prefix until retention drops them. A note the app wrote as a
      // fact keeps it beside its words.
      return {
        kind: event.tone ?? "info",
        text: event.text,
        ...(event.said ? { said: event.said } : {}),
      };
    case "memory_noted":
      return line("info", said("feedRemembered", { text: event.text }));
    case "personalized":
      // A settled run that came back where it started leaves no line.
      if (event.run?.withdrawn) return null;
      // Tier A of talk-to-personalize: the change is the line, no card.
      return line(
        "info",
        event.actor === "captain"
          ? event.panel
            ? said("feedCaptainSetInPanel", { text: event.text, panel: event.panel })
            : said("feedCaptainSet", { text: event.text })
          : event.actor
            ? said("feedFirstMateSet", { text: event.text })
            : said("feedPersonalized", { text: event.text }),
      );
    case "user_turn": {
      const preview = reportSummary(event.text);
      return line("you", preview ? said("feedCaptainSaid", { preview }) : said("feedCaptainImage"));
    }
    case "repo_setup": {
      const fills = { who: byWho(event.actor), name: event.name };
      if (event.project)
        return line(
          "info",
          said("feedProjectRepositoryAdded", { ...fills, project: event.project }),
        );
      return line(
        "info",
        event.kind === "clone"
          ? said("feedProjectCloned", fills)
          : event.kind === "init"
            ? said("feedProjectCreated", fills)
            : said("feedProjectLinked", fills),
      );
    }
    case "repo_configured": {
      // The standing rigor is named only when the repository declares one
      // (delivery rigor phase 3); a derived rigor is the default and says
      // nothing here.
      if (event.said)
        return { kind: "info", text: event.description ?? englishOf(event.said), said: event.said };
      if (event.description) return { kind: "info", text: event.description };
      const fills = {
        who: byWho(event.actor, event.panel),
        name: event.name,
        delivery: DELIVERY_SAID[event.delivery] ?? event.delivery,
        merging: event.autonomy ? saidPart("feedMergesOnItsOwn") : saidPart("feedAsksFirst"),
      };
      return line(
        "info",
        event.rigor
          ? said("feedProjectSettingsCare", {
              ...fills,
              care: CARE_SAID[event.rigor] ?? event.rigor,
            })
          : said("feedProjectSettings", fills),
      );
    }
    case "repo_runs_on":
      return { kind: "info", text: event.text, ...(event.said ? { said: event.said } : {}) };
    case "repo_unregistered":
      return line(
        "info",
        said("feedProjectRemoved", { who: byWho(event.actor), name: event.name }),
      );
    case "device_joined":
      return { kind: "info", text: deviceJoinedLine(event) };
    case "device_setup":
    case "device_update":
    case "device_connection":
      return { kind: event.tone, text: event.text };
    case "device_left":
      return line("info", said("feedComputerLeft", { name: event.name }));
    case "device_signed_in":
      return line(
        "info",
        said("feedComputerSignedIn", { who: event.who, provider: event.provider }),
      );
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
      return line("danger", said("feedFirstMateProblem", { problem: plainProblem(event.error) }));
    }
    default: {
      // Adding a listed type without its author, or an author without its type, fails typecheck.
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/**
 * The run of lines an event's line belongs to, when it declares one
 * (`feedRunSchema`): the captain's settled run on one setting
 * (docs/orchestrator-contract.md, "Settled runs"), or a copy's count of what
 * it sent so far (docs/devices.md, "How far the copy has gone").
 */
export function feedRunOf(event: FmEvent): { id: string; withdrawn?: boolean } | undefined {
  return event.type === "personalized" ||
    event.type === "device_setup" ||
    event.type === "device_update"
    ? event.run
    : undefined;
}

/**
 * Whether an event changes what Activity holds: a line written or rewritten
 * in place (`feedLineFrom`), or a run's line withdrawn
 * (docs/orchestrator-contract.md, "Settled runs").
 */
export function changesFeed(event: FmEvent): boolean {
  return feedLineFrom(event) !== null || feedRunOf(event)?.withdrawn === true;
}
