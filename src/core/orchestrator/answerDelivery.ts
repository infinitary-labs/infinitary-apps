import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { cutText } from "@shared/textCut";
import { escapeCardText } from "./cardText";

/**
 * The answer-delivery check (docs/task-capture.md "Answer delivery"): for
 * each captain message, did at least one action take effect after Firstmate
 * read it? The host judges delivery, never whether an answer is right, and
 * reads only typed facts - the tool that succeeded, not the words it said.
 *
 * This module is the pure part: the saved shapes, the verdict, the tools the
 * output-only retry refuses, and the one notice's card. `FirstmateAgent`
 * records the facts where actions succeed and calls `judgeDelivery` at the
 * turn's end; `TaskService` is the only writer of the saved state.
 */

/**
 * Where a captain message stands. `pending` waits for the turn that reads it,
 * `held` was read by a turn that failed or paused (it is judged when a turn
 * serves it again), `retrying` has had its one output-only retry queued,
 * `unresolved` still had no action after it and got its one notice, and
 * `legacy` is every message from before the check, never judged.
 */
export type AskDelivery = "pending" | "held" | "covered" | "retrying" | "unresolved" | "legacy";

/** The states a message can still be judged in. */
export const JUDGEABLE_DELIVERY: readonly AskDelivery[] = ["pending", "held", "retrying"];

/**
 * What kind of action took effect: a card shown or revised, the first
 * mate's words written into a card's replies (its closing words, or a line
 * alone on someone else's card), work started, steered, stopped or settled,
 * a setting or operation recorded, a card closed, a reaction.
 */
export type DeliveryActionKind = "card" | "reply" | "work" | "record" | "close" | "reaction";

/** Why a card was refused, when the refusal is typed. */
export type DeliveryRefusal = "crewmate-owns" | "card-refused";

export type DeliveryEntry =
  | { outcome: "action"; kind: DeliveryActionKind; tool: string; ref?: string; at: number }
  | { outcome: "refused"; tool: string; reason: DeliveryRefusal; ref?: string; at: number };

/** The facts saved for one message, oldest first. `retryOf` links an Ask again to its message. */
export type DeliveryFacts = {
  entries: DeliveryEntry[];
  retryOf?: string;
  /** The readable receipt when the saved turn text also carries model-only detail. */
  receipt?: string;
};

/** An entry as the recorder takes it: the check stamps `at`. */
export type DeliveryNote = DeliveryEntry extends infer E
  ? E extends unknown
    ? Omit<E, "at">
    : never
  : never;

const ACTION_KINDS: readonly string[] = ["card", "reply", "work", "record", "close", "reaction"];
const REFUSALS: readonly string[] = ["crewmate-owns", "card-refused"];

function entryOf(value: unknown): DeliveryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.tool !== "string" || typeof entry.at !== "number") return undefined;
  const ref = typeof entry.ref === "string" ? { ref: entry.ref } : {};
  if (entry.outcome === "action" && typeof entry.kind === "string") {
    if (!ACTION_KINDS.includes(entry.kind)) return undefined;
    return {
      outcome: "action",
      kind: entry.kind as DeliveryActionKind,
      tool: entry.tool,
      at: entry.at,
      ...ref,
    };
  }
  if (entry.outcome === "refused" && typeof entry.reason === "string") {
    if (!REFUSALS.includes(entry.reason)) return undefined;
    return {
      outcome: "refused",
      tool: entry.tool,
      reason: entry.reason as DeliveryRefusal,
      at: entry.at,
      ...ref,
    };
  }
  return undefined;
}

/** The saved JSON back to facts; anything unreadable is no facts, never a throw. */
export function parseDeliveryFacts(json: string | null | undefined): DeliveryFacts {
  if (!json) return { entries: [] };
  try {
    const parsed = JSON.parse(json) as { entries?: unknown; retryOf?: unknown; receipt?: unknown };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.flatMap((value) => entryOf(value) ?? [])
      : [];
    return {
      entries,
      ...(typeof parsed.retryOf === "string" ? { retryOf: parsed.retryOf } : {}),
      ...(typeof parsed.receipt === "string" ? { receipt: parsed.receipt } : {}),
    };
  } catch {
    return { entries: [] };
  }
}

/**
 * Whether an action took effect for the message. Lookups and refusals are
 * never actions (they are never recorded as one); a held steer counts, as
 * the captain chose; a reaction after a refused card does not, because
 * Firstmate meant to show something and could not.
 */
export function actionTookEffect(entries: readonly DeliveryEntry[]): boolean {
  let cardRefused = false;
  for (const entry of entries) {
    if (entry.outcome === "refused") {
      if (entry.tool === "emit_card") cardRefused = true;
      continue;
    }
    if (entry.kind === "reaction" && cardRefused) continue;
    return true;
  }
  return false;
}

/** What the check does with a message after a turn that read it. */
export type DeliveryVerdict = "covered" | "retry" | "notice";

/**
 * One message, judged after a clean turn that read it: covered by an action,
 * else one output-only retry, and once that retry has been served, one
 * notice. A state that is not judgeable is never touched again.
 */
export function judgeDelivery(
  delivery: AskDelivery,
  entries: readonly DeliveryEntry[],
): DeliveryVerdict | undefined {
  if (!JUDGEABLE_DELIVERY.includes(delivery)) return undefined;
  if (actionTookEffect(entries)) return "covered";
  return delivery === "retrying" ? "notice" : "retry";
}

/** The typed reason the last refused card gives, for the retry wake and the notice. */
export function refusalOf(entries: readonly DeliveryEntry[]): DeliveryEntry | undefined {
  return entries.findLast((entry) => entry.outcome === "refused");
}

/**
 * The tools an output-only retry refuses (as tool text): everything that
 * starts, steers, stops or closes work, or changes a setting. The lookups,
 * emit_card, close_card and emote stay, and so does link_tasks, which
 * names the task that took ended work over: the retry may only show an
 * answer or say where the work went.
 */
export const ANSWER_ONLY_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "spawn_crewmate",
  "steer_crewmate",
  "interrupt_crewmate",
  "settle_task",
  "create_task",
  "update_task",
  "schedule_prompt",
  "cancel_schedule",
  "remember",
  "forget",
  "record_knowledge",
  "app_change",
  "personalize",
  "install_plugin",
  "flag_missed_escalation",
  "flag_duplicate",
]);

export const ANSWER_ONLY_REFUSAL =
  "This turn only shows the captain the answer they are missing. Starting, steering, stopping or closing work and changing settings are not available now: show the answer with emit_card and answering true (or answer in the card's thread), link the task that took the work over with link_tasks, or react with emote.";

/**
 * The crewmate step's one ask (INF-1610, docs/task-capture.md "How a
 * message ends"), as the finished report's refusal: the task stays open
 * until the crewmate shows the answering card or says why it cannot.
 */
export const CREWMATE_ANSWER_ASK =
  "Report refused once: your task is the last work for the captain's message and no card of yours answers it. Show the card that answers it with emit_card and answering true - or revise your open card under the same id with answering true - then report. A note the captain closed stays closed: if they closed the note that answers it, or you cannot answer it, report finished again saying so, and the first mate answers it.";

/** The one notice's card title. */
export const ANSWER_NOTICE_TITLE = "Your first mate has not answered your message";

const NOTICE_CARD_PREFIX = "card-ask-";

/** The one notice's card id, fixed per message so a restart never raises a second. */
export function noticeCardId(askId: string): string {
  return `${NOTICE_CARD_PREFIX}${askId}`;
}

/** The message a notice card is for, or undefined for any other card. */
export function noticeAskId(cardId: string): string | undefined {
  if (!cardId.startsWith(NOTICE_CARD_PREFIX)) return undefined;
  return cardId.slice(NOTICE_CARD_PREFIX.length);
}

/** How much of the captain's message the notice and the wake quote. */
export const EXCERPT_CHARS = 240;

/** The captain's words, whitespace flattened and clipped. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${cutText(flat, EXCERPT_CHARS - 1)}…`;
}

const REASON_SENTENCE: Record<DeliveryRefusal, string> = {
  "crewmate-owns":
    "The crewmate working on it already owns the card for it, so your first mate's card was refused.",
  "card-refused": "Your first mate tried to answer with a card the app refused.",
};

/**
 * The notice for a message that still had no action after its retry: the
 * captain's own words, escaped, a typed reason when one is known, and the two
 * ways out. It never quotes closing words, refusal text or an error.
 */
export function noticeCard(
  askId: string,
  text: string,
  entries: readonly DeliveryEntry[],
): Pick<Card, "id" | "title" | "meta" | "body" | "actions"> {
  const refusal = refusalOf(entries);
  const reason = refusal?.outcome === "refused" ? REASON_SENTENCE[refusal.reason] : undefined;
  return {
    id: noticeCardId(askId),
    title: ANSWER_NOTICE_TITLE,
    meta: FIRSTMATE_CARD_META,
    body: [
      `<p>Nothing came of this message, so you have no answer yet:</p>`,
      `<blockquote>${escapeCardText(excerptOf(text))}</blockquote>`,
      ...(reason ? [`<p>${reason}</p>`] : []),
      `<p>Ask again sends it once more as a new message. Leave it keeps things as they are.</p>`,
    ].join(""),
    actions: [
      {
        id: "ask-again",
        label: "Ask again",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "ask-again", arg: askId },
      },
      { id: "leave-it", label: "Leave it" },
    ],
  };
}
