import * as m from "@shared/i18n/messages.generated";
/**
 * Words for reading a conversation round (docs/composer.md "The last turn"
 * and "The conversation"), in a plain module its journey can load.
 */
export const OPEN_QUOTE = "“";
export const CLOSE_QUOTE = "”";

/**
 * The conversation's heading, worded as the module loads (English, before
 * any language is set) for a spec; the card reads `conversationHeading`
 * when it is shown.
 */
export const CONVERSATION_HEADING = m.shellConversationHeading();

export const conversationHeading = (): string => m.shellConversationHeading();

/** A message that was only pictures, in place of its words; worded as `CONVERSATION_HEADING` is. */
export const PICTURE_ONLY_WORDS = m.shellLastTurnPictureOnly();

export const quoted = (words: string) => `${OPEN_QUOTE}${words}${CLOSE_QUOTE}`;
