import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";

/**
 * The Firstmate's reply line (INF-772's plan, the captain's Approve and
 * build; docs/composer.md "The last turn"): the one line the captain reads
 * beside their last message once the turn that read it ends.
 *
 * Its closing words say it, one short sentence by instruction alone (the
 * host cuts nothing it did not write), whatever else the turn did (INF-4453,
 * the captain's words: "any turn ending reply should count as the line and
 * show up"). When the turn closed with no words, the typed facts it recorded
 * where each call succeeded give the line: the latest card it showed, else
 * the app's own words, else Got it when something took effect. No words and
 * nothing took effect: no line. The answer check judges the message apart.
 */
export type ReplyFacts = {
  closing?: string;
  /** Latest shown or revised card title. */
  latest?: string;
  /** Latest app-written reply, used only when the Firstmate gave no words. */
  app?: string;
  acted?: boolean;
};

export function replyLine(facts: ReplyFacts): string | undefined {
  const closing = facts.closing?.replace(/\s+/gu, " ").trim();
  return (
    closing || (facts.latest ?? facts.app ?? (facts.acted ? AUTOMATIC_EMOTE_WORDS.nod : undefined))
  );
}

/**
 * The closing words as the Firstmate wrote them, line breaks kept, when they
 * are the reply line and differ from it: the conversation shows them
 * (docs/composer.md "The conversation"). Otherwise nothing, and it shows
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
