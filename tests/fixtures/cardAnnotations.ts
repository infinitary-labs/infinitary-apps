/** The queue-check example used in the captain-approved annotation prototype. */
export const ANNOTATION_TITLE = "Show a queue send-back as a Batch check";
export const ANNOTATION_BODY =
  '<p>A change the queue sent back showed as a plain failed check.</p>\n<p>The card now names the batch and the check that failed.</p>\n<fieldset><legend>Which checks should the row name?</legend><label><input type="checkbox" name="checks" value="failed">The check that failed only</label></fieldset>';
export const ANNOTATION_RANGE = "plain failed check";
export const ANNOTATION_COMMENT = "Name the batch here too";
export const ANNOTATION_WORDS = "Keep both notes together";

export const ANNOTATION_RANGE_END = "The card now names the batch";

/** The real drawing used while checking the host annotation/modal boundary. */
export const ANNOTATION_DRAWING_CAPTION = "The queue check stays linked to its card";
export const ANNOTATION_DRAWING = `<figure><svg viewBox="0 0 750 120" width="100%" role="img" aria-label="${ANNOTATION_DRAWING_CAPTION}"><rect x="20" y="25" width="280" height="70" rx="8" fill="var(--bg-2)" stroke="var(--line-2)"/><path d="M300 60H450" stroke="var(--accent)"/><rect x="450" y="25" width="280" height="70" rx="8" fill="var(--accent-dim)" stroke="var(--accent)"/><text x="40" y="65" fill="var(--fg-1)">Queue check</text><text x="470" y="65" fill="var(--fg-1)">Card</text></svg><figcaption>${ANNOTATION_DRAWING_CAPTION}</figcaption></figure>`;
