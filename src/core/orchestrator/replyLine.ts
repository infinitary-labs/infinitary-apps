import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";

/**
 * The Firstmate's reply line (FI3-1089's plan, the captain's Approve and
 * build; docs/composer.md "The last turn"): the one line the captain reads
 * beside their last message once the turn that read it ends. It is chosen
 * from typed facts the turn recorded where each call succeeded, never from
 * the closing words, which stay off the window.
 *
 * The latest authored reply after the newest message was read wins over app words.
 * An action or words-only card-thread answer is a fallback, never a reply
 * that overwrites an authored reply or app words.
 */
export type ReplyFacts = {
  /** Latest authored emote words or shown/revised card title. */
  latest?: string;
  /** Latest app-written reply, used only when the Firstmate gave no words. */
  app?: string;
  /** A card whose thread was answered only in words, when nothing else replied. */
  thread?: string;
  /** Some action took effect. */
  acted?: boolean;
};

export function replyLine(facts: ReplyFacts): string | undefined {
  return (
    facts.latest ??
    facts.app ??
    facts.thread ??
    (facts.acted ? AUTOMATIC_EMOTE_WORDS.nod : undefined)
  );
}

/** Starting work says what took effect, not just the work still to do. */
export function startedReply(title: string): string {
  return `Started: ${title}`;
}
