import * as m from "@shared/i18n/messages.generated";
/**
 * Words for reading a conversation round (docs/composer.md "The last turn"),
 * in a plain module its journey can load.
 */
export const OPEN_QUOTE = "“";
export const CLOSE_QUOTE = "”";

/**
 * The read-only conversation note's heading, worded as the module loads
 * (English, before any language is set) for a spec; the note reads
 * `conversationHeading` when it is shown.
 */
export const CONVERSATION_HEADING = m.shellConversationHeading();

/** The read-only conversation note's heading, worded when shown. */
export const conversationHeading = (): string => m.shellConversationHeading();

/** Words someone said, inside their quotation marks. */
export const quoted = (words: string) => `${OPEN_QUOTE}${words}${CLOSE_QUOTE}`;
