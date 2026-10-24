/**
 * The marks around words someone said on the last turn and the reply note
 * (docs/composer.md "The last turn"), in a plain module a spec can load.
 */
export const OPEN_QUOTE = "“";
export const CLOSE_QUOTE = "”";

/** Words someone said, inside their quotation marks. */
export const quoted = (words: string) => `${OPEN_QUOTE}${words}${CLOSE_QUOTE}`;
