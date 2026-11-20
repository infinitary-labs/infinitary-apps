/**
 * Task-supplied text inside a card fragment: titles and keys are the
 * crew's words, and the body is rendered as HTML, so they are escaped.
 */
export function escapeCardText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
