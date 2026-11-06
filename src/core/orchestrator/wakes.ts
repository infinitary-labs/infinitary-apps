/**
 * The typed wake envelope (the primitives review's P3; docs/inbox.md, "The
 * wake envelope"). A wake the host sends names the facts it is about and the
 * ways out, and is rendered to prose once, by `renderWake`, where it is
 * served: the Firstmate's drain, a crewmate's lane, and the ledger row the
 * replay scorer matches the served text against. Nothing an emitter holds
 * as a typed fact is spelled into a sentence at the call site, so the inbox
 * can dedupe a wake by what it says rather than by its wording.
 *
 * Every wake the host composes carries typed facts: the idle ladder, the
 * honest retry's outage wakes, the cut-off wakes and the job bound, and
 * the rest - a crewmate's report and a reviewer's verdict, a failed turn or
 * task, a settle's outcome, a card choice, a queued start, the quiet
 * watchdog, a job's exit, a schedule firing, the welcome, and the
 * host-worded steers on a crewmate's lane - and the captain's own turn,
 * framed as his. Prose (`text`) is what an agent wrote - the Firstmate's
 * guidance, a brief - and a row an older build queued; it renders as
 * itself.
 *
 * Each family of wakes keeps its facts, builders and words in a file of its
 * own (idleWakes.ts, outageWakes.ts, jobWakes.ts, reportWakes.ts,
 * deliveryWakes.ts, captainWakes.ts, turnWakes.ts, startWakes.ts and
 * noticeWakes.ts); this file keeps the envelope, the carriers, the drain
 * and `WAKE_WORDS`, the one map of every kind's words.
 */

import { type AttachmentRef, attachmentWords } from "@shared/attachments";
import { ATTACHMENTS_DROPPED_NOTE } from "@shared/cards";
import type { ServedOrigin } from "@shared/servedFrame";
import type { InboxRow, WAKE_ENVELOPE_VERSION } from "../storage/inboxStore";
import {
  CAPTAIN_WORDS,
  type CaptainFacts,
  CREWMATE_TAB_STEER_LEAD,
  threadReplyLead,
} from "./captainWakes";
import { DELIVERY_WORDS, type DeliveryFacts } from "./deliveryWakes";
import type { HoldWay } from "./holds";
import { IDLE_WORDS, type IdleFacts } from "./idleWakes";
import { JOB_WORDS, type JobFacts } from "./jobWakes";
import { NOTICE_WORDS, type NoticeFacts } from "./noticeWakes";
import { OUTAGE_WORDS, type OutageFacts } from "./outageWakes";
import { REPORT_WORDS, type ReportFacts } from "./reportWakes";
import { START_WORDS, type StartFacts } from "./startWakes";
import { TURN_WORDS, type TurnFacts } from "./turnWakes";

/**
 * The words that name a guidance mark on the captain's steer while his kept
 * merge approval stands (FI3-662), followed by the mark; a scripted stand-in
 * reads the mark after them.
 */
export const GUIDANCE_MARK_WORDS = "check_change captainGuidance with mark";

/** What the crewmate is told beside the captain's guidance that holds his kept merge. */
function guidanceMarkNote(mark: number): string {
  return `[kept merge] The captain's merge approval on this task stands, so these words of theirs hold its merge until you declare their impact: ${GUIDANCE_MARK_WORDS} ${mark} - none if they leave the approved work as it was, changed-work if they change it (then put up a new completion card when the work is ready).`;
}

/** The task a hold-shaped wake is about, as its ways block names it. */
export type WakeTask = {
  id: string;
  title: string;
  difficulty?: "low" | "medium" | "high" | "premium" | null;
  shape?: { escalation?: { attempt: number } } | null;
};

/** A task named by its key as well (its key, or its id when it has none). */
export type WakeKeyedTask = WakeTask & { key: string };

/** Which lane a wake that goes to either is worded for. */
export type WakeLane = "firstmate" | "crewmate";

/**
 * The wakes that carry words of any kind into a lane: the captain's own
 * turn, guidance whose pictures or kept merge ride beside it, and a
 * response request or its cancelling.
 */
type CarrierFacts =
  | { kind: "responses-cancelled"; requests: string[]; guidance: string | WakeFacts }
  | { kind: "response-request"; requestId: string; guidance: string | WakeFacts }
  | {
      /**
       * The captain's words as the Firstmate is served them: live, or parked
       * on its lane (benched, or a steer the session refused).
       */
      kind: "captain-turn";
      words: string;
      /** A legacy row whose pictures were not kept; the parked copy says they are gone. */
      imagesDropped: boolean;
      /** The accepted message's own picture copies; they ride the turn when it is served. */
      attachments?: AttachmentRef[];
      /**
       * The message these words are, on a parked copy: the turn that serves
       * the row reads that message and judges it (answer delivery). Absent
       * on rows older builds queued and on words with no saved message.
       */
      askId?: string;
    }
  | {
      /** Guidance whose pictures a legacy durable copy could not keep, and says so. */
      kind: "attachments-dropped";
      guidance: string | WakeFacts;
    }
  | {
      /** Guidance whose pictures the message keeps copies of; they ride its delivery. */
      kind: "attachments-kept";
      guidance: string | WakeFacts;
      attachments: AttachmentRef[];
    }
  | {
      /**
       * The captain's guidance while his kept merge approval stands
       * (FI3-662), with the mark that holds the merge until its crewmate
       * declares the guidance's impact.
       */
      kind: "kept-merge-guidance";
      guidance: string | WakeFacts;
      mark: number;
    };

/**
 * The typed facts of one wake. `kind` names what it is; everything else is
 * a fact the host read, never a sentence. A new wake adds its kind to its
 * family's facts, and its words to that family's map, which `WAKE_WORDS`
 * gathers.
 */
export type WakeFacts =
  | CarrierFacts
  | IdleFacts
  | OutageFacts
  | JobFacts
  | ReportFacts
  | DeliveryFacts
  | CaptainFacts
  | TurnFacts
  | StartFacts
  | NoticeFacts;

/**
 * A wake whose facts are typed, with the ways out when it is a hold. `once`
 * names the fact a wake goes out once for (an outage, a job past its
 * bound): the inbox records it durably with the row it queues and never
 * queues a wake with that name about that task again (`enqueueWake`).
 */
export type TypedWake = { facts: WakeFacts; ways?: HoldWay[]; once?: string };

/** What the inbox holds: prose an agent wrote (the Firstmate's steer, a brief), or a typed wake. */
export type WakeBody = string | TypedWake;

/**
 * One inbox row's message (`inbox.payload`): `origin` is the existing
 * `ServedOrigin` column and `ref` the task column; the payload itself holds
 * `{v, facts, ways}` or, for prose, `{v, text}`.
 */
export type WakeEnvelope = {
  v: typeof WAKE_ENVELOPE_VERSION;
  origin: ServedOrigin | null;
  ref: string | null;
  facts?: WakeFacts;
  ways?: HoldWay[];
  text?: string;
};

/**
 * One family's words: for each kind of its facts, the function that words
 * it from those facts and the wake's ways and text. The compiler holds a
 * family to words for each of its kinds and no others, and `WAKE_WORDS` to
 * every kind.
 */
export type KindWords<F extends { kind: string }> = {
  [K in F["kind"]]: (
    facts: Extract<F, { kind: K }>,
    wake: Pick<WakeEnvelope, "ways" | "text">,
  ) => string;
};

/** The captain's words, framed as his turn (`[user]`), and whether their pictures were dropped. */
export function captainTurn(
  words: string,
  imagesDropped: boolean,
  attachments?: readonly AttachmentRef[],
  askId?: string,
): TypedWake {
  return {
    facts: {
      kind: "captain-turn",
      words,
      imagesDropped,
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
      ...(askId ? { askId } : {}),
    },
  };
}

/**
 * Where the captain's own words sit in a thread reply's steer, or a line he
 * typed in the Crewmate tab, as `renderWake` words it
 * (`SteerEventData.words`), so the record reads them without a copy;
 * undefined for any other wake, or one not worded that way.
 */
export function replyWordsSpan(wake: WakeBody): { from: number; to: number } | undefined {
  if (typeof wake === "string") return undefined;
  const lead =
    wake.facts.kind === "thread-reply"
      ? threadReplyLead(wake.facts)
      : wake.facts.kind === "crewmate-tab-line"
        ? CREWMATE_TAB_STEER_LEAD
        : undefined;
  if (lead === undefined || !("words" in wake.facts)) return undefined;
  const words = wake.facts.words;
  const from = lead.length + 1;
  const to = from + words.length;
  return renderWake(wake).slice(from, to) === words ? { from, to } : undefined;
}

/**
 * The one renderer: a wake's prose, from its facts and ways, or its text
 * when the row holds prose. Pure and deterministic, so the
 * ledger's copy and the served copy are the same bytes.
 */
export function renderWake(wake: string | Pick<WakeEnvelope, "facts" | "ways" | "text">): string {
  if (typeof wake === "string") return wake;
  const facts = wake.facts;
  if (!facts) return wake.text ?? "";
  try {
    return renderFacts(facts, wake);
  } catch {
    // A known kind whose facts are not the shape this build words - a row
    // an older build queued, or a malformed one - is served as data, never
    // thrown: one row must not wedge its lane's drain.
    return wake.text ?? unknownWake(facts, wake.ways);
  }
}

/** The carriers' words: each wraps the words of the guidance it carries. */
const CARRIER_WORDS: KindWords<CarrierFacts> = {
  "responses-cancelled": (facts, wake) =>
    `${typeof facts.guidance === "string" ? facts.guidance : renderWake({ facts: facts.guidance, ways: wake.ways })}\n\nThe first mate cancelled response requests ${facts.requests.join(", ")}. Their history remains; do not submit new answers for those requests.`,
  "response-request": (facts, wake) =>
    `${typeof facts.guidance === "string" ? facts.guidance : renderWake({ facts: facts.guidance, ways: wake.ways })}\n\nResponse requested: ${facts.requestId}. In report.responses name request_id, a stable response_id, and status answered or not-yet-answered. The report text is your exact response. Submission saves it and queues the first mate immediately, even while work continues. Ordinary reports do not answer this request.`,
  "captain-turn": (facts) =>
    `[user]\n${facts.words}${facts.imagesDropped ? `\n\n${ATTACHMENTS_DROPPED_NOTE}` : ""}`,
  "attachments-kept": (facts, wake) =>
    `${
      typeof facts.guidance === "string"
        ? facts.guidance
        : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
    }\n\n[attached: ${attachmentWords(facts.attachments)}]`,
  "kept-merge-guidance": (facts, wake) =>
    `${
      typeof facts.guidance === "string"
        ? facts.guidance
        : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
    }\n\n${guidanceMarkNote(facts.mark)}`,
  "attachments-dropped": (facts, wake) =>
    `${ATTACHMENTS_DROPPED_NOTE}\n\n${
      typeof facts.guidance === "string"
        ? facts.guidance
        : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
    }`,
};

/** Every kind's words, one map the compiler holds to name each kind. */
const WAKE_WORDS: KindWords<WakeFacts> = {
  ...CARRIER_WORDS,
  ...IDLE_WORDS,
  ...OUTAGE_WORDS,
  ...JOB_WORDS,
  ...REPORT_WORDS,
  ...DELIVERY_WORDS,
  ...CAPTAIN_WORDS,
  ...TURN_WORDS,
  ...START_WORDS,
  ...NOTICE_WORDS,
};

function renderFacts(facts: WakeFacts, wake: Pick<WakeEnvelope, "ways" | "text">): string {
  // A kind this build does not know - a row a newer build queued - is
  // still served: its text if it carries one, else its facts as data.
  if (!Object.hasOwn(WAKE_WORDS, facts.kind)) return wake.text ?? unknownWake(facts, wake.ways);
  const words = WAKE_WORDS[facts.kind] as (
    facts: WakeFacts,
    wake: Pick<WakeEnvelope, "ways" | "text">,
  ) => string;
  return words(facts, wake);
}

/** One inbox row as the drain serves it: its prose, and the row it came from. */
export type DrainedWake = {
  id: number;
  ref: string | null;
  origin: ServedOrigin | null;
  body: string;
};

/**
 * The one drain (the primitives review's P4): a lane's rows as they are
 * served, each rendered once by `renderWake`, oldest first. The Firstmate
 * frames each as a segment of its turn; a crewmate's lane joins them into
 * one turn (`laneTurnText`) or quotes them (`laneText`).
 */
export function drainWakes(rows: readonly InboxRow[]): DrainedWake[] {
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref ?? null,
    origin: row.origin ?? null,
    body: renderWake(row),
  }));
}

/**
 * How a crewmate's message opens when a quit or crash cut short the turn
 * that was serving it and the next launch delivers it again (docs/inbox.md,
 * "A turn a quit or crash cut"); a scripted stand-in recognizes it by it.
 */
export const RESTART_REPLAY_NOTE =
  "Delivered again after a restart: the app closed - a quit or a crash - while your turn on the message below was running, so that turn may already have done part of it. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - and carry on from there rather than doing it twice.";

/**
 * A crewmate lane's rows as the words they carry, joined by a space: the
 * guidance a feed line or a wake quotes. The turn that serves them is
 * `laneTurnText`.
 */
export function laneText(rows: readonly InboxRow[]): string {
  return drainWakes(rows)
    .map((wake) => wake.body)
    .join(" ");
}

/** The rows a lane's turn opens with: why its conversation is new, then why its last turn stopped. */
const LEADING_KINDS: readonly string[] = ["conversation-restart", "turn-resumed"];

/**
 * A crewmate lane's rows as the turn that serves them: a renewed
 * conversation's reason comes first, so it rides the message that brought
 * the crewmate back, then why the app stopped its last turn part way, and
 * each row a quit or crash cut a turn on opens with `RESTART_REPLAY_NOTE`,
 * so the crewmate reads a replay as one, never as new work.
 */
export function laneTurnText(rows: readonly InboxRow[]): string {
  const leading = LEADING_KINDS.flatMap((kind) => rows.filter((row) => row.facts?.kind === kind));
  const rest = rows.filter((row) => !LEADING_KINDS.includes(row.facts?.kind ?? ""));
  return [...leading, ...rest]
    .map((row) => {
      const body = renderWake(row);
      return row.cuts > 0 ? `${RESTART_REPLAY_NOTE}\n\n${body}` : body;
    })
    .join("\n\n");
}

/**
 * Guidance whose pictures ride only the live steer: the durable copy says
 * they could not be kept, so a redelivered turn never loses them silently.
 */
export function withAttachmentsKept(
  body: WakeBody,
  attachments: readonly AttachmentRef[],
): TypedWake {
  if (typeof body === "string") {
    return { facts: { kind: "attachments-kept", guidance: body, attachments: [...attachments] } };
  }
  return {
    facts: { kind: "attachments-kept", guidance: body.facts, attachments: [...attachments] },
    ...(body.ways ? { ways: body.ways } : {}),
  };
}

/**
 * The captain's guidance with the mark that holds his kept merge (FI3-662):
 * the mark rides the message itself, so its crewmate can declare only
 * guidance it read. Pictures wrap outside it (`withAttachmentsKept`).
 */
export function withGuidanceMark(body: WakeBody, mark: number): TypedWake {
  if (typeof body === "string") {
    return { facts: { kind: "kept-merge-guidance", guidance: body, mark } };
  }
  return {
    facts: { kind: "kept-merge-guidance", guidance: body.facts, mark },
    ...(body.ways ? { ways: body.ways } : {}),
    ...(body.once !== undefined ? { once: body.once } : {}),
  };
}

/** The pictures a lane row's message keeps copies of, in order. */
export function rowAttachments(rows: readonly InboxRow[]): AttachmentRef[] {
  return rows.flatMap((row) => {
    let facts = row.facts;
    while (
      (facts?.kind === "response-request" || facts?.kind === "responses-cancelled") &&
      typeof facts.guidance !== "string"
    )
      facts = facts.guidance;
    if (facts?.kind === "attachments-kept") return facts.attachments;
    if (facts?.kind === "captain-turn") return facts.attachments ?? [];
    return [];
  });
}

export function withAttachmentsDropped(body: WakeBody): TypedWake {
  if (typeof body === "string") return { facts: { kind: "attachments-dropped", guidance: body } };
  return {
    facts: { kind: "attachments-dropped", guidance: body.facts },
    ...(body.ways ? { ways: body.ways } : {}),
  };
}

function unknownWake(facts: unknown, ways: HoldWay[] | undefined): string {
  return `[fm-op] a wake this version cannot word:\n\`\`\`json\n${JSON.stringify({ facts, ...(ways ? { ways } : {}) }, null, 2)}\n\`\`\``;
}
