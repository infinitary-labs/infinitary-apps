import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";

/**
 * The Firstmate's reply line (INF-772's plan, the captain's Approve and
 * build; docs/composer.md "The last turn"): the one line the captain reads
 * beside their last message once the turn that read it ends.
 *
 * Its closing words say it, one short sentence by instruction alone (the
 * host cuts nothing it did not write), whenever something took effect.
 * The typed facts the turn recorded where each call succeeded decide
 * whether anything did, and give the line when the turn closed with no
 * words: the latest card it showed, else the app's own words, else Got it.
 * Nothing took effect: no line, and the answer check retries.
 */
export type ReplyFacts = {
  /** The turn's closing words. */
  closing?: string;
  /** Latest shown or revised card title. */
  latest?: string;
  /** Latest app-written reply, used only when the Firstmate gave no words. */
  app?: string;
  /** Some action took effect. */
  acted?: boolean;
};

export function replyLine(facts: ReplyFacts): string | undefined {
  const typed = facts.latest ?? facts.app ?? (facts.acted ? AUTOMATIC_EMOTE_WORDS.nod : undefined);
  if (typed === undefined) return undefined;
  // One line: every whitespace run, line breaks included, is one space.
  const closing = facts.closing?.replace(/\s+/gu, " ").trim();
  return closing || typed;
}

/**
 * The closing words as the Firstmate wrote them, line breaks kept, when they
 * are the reply line and differ from it: the reply note shows them
 * (docs/composer.md "The reply note"). Otherwise nothing, and the note shows
 * the line.
 */
export function replyWords(facts: ReplyFacts): string | undefined {
  const words = facts.closing?.trim();
  const line = replyLine(facts);
  return words && line !== undefined && words !== line ? words : undefined;
}

/** Starting work says what took effect, not just the work still to do. */
export function startedReply(title: string): string {
  return `Started: ${title}`;
}
