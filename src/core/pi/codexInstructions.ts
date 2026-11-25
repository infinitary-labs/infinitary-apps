/**
 * The `instructions` every Codex request sends once the session's own
 * instructions travel as the first input item. The service still asks for the
 * field, and one fixed line keeps the requests of a conversation alike, so
 * its WebSocket keeps sending only what is new.
 */
// i18n-exempt: served to the model, never shown to a person
export const CODEX_INSTRUCTIONS = "Follow the developer message at the start of the conversation.";

/**
 * Moves a Codex request's `instructions` to the front of its input as a
 * developer message, the way Pi's OpenAI Responses driver sends a system
 * prompt. GPT-6.2 never answers `instructions` from its prompt cache, so a
 * crewmate's whole instructions were paid for again on every request, while
 * the input's leading items are reused like the rest of the conversation.
 */
export function instructionsInInput(body: Record<string, unknown>): Record<string, unknown> {
  const { instructions, input } = body;
  if (typeof instructions !== "string" || instructions === CODEX_INSTRUCTIONS) return body;
  if (!Array.isArray(input)) return body;
  return {
    ...body,
    instructions: CODEX_INSTRUCTIONS,
    input: [{ role: "developer", content: instructions }, ...input],
  };
}
