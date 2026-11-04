/**
 * Words for reading a conversation round (docs/composer.md "The last turn"),
 * in a plain module its journey can load.
 */
export const OPEN_QUOTE = "“";
export const CLOSE_QUOTE = "”";

/** The read-only conversation note's heading. */
export const CONVERSATION_HEADING = "Conversation";

/** Words someone said, inside their quotation marks. */
export const quoted = (words: string) => `${OPEN_QUOTE}${words}${CLOSE_QUOTE}`;
