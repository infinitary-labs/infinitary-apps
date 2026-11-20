export function presentationRegionMarkers(taskId: string): { start: string; end: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Invalid story task identity.");
  return {
    start: `<!-- infinitary-story:${taskId}:start -->`,
    end: `<!-- infinitary-story:${taskId}:end -->`,
  };
}

/**
 * The first line of each of the app's own comments on a batch's pull request
 * that carry the stories its description cannot hold (docs/forge.md,
 * "Batches of your own"): how the app finds them again among the pull
 * request's comments, to rewrite or delete them as the batch changes.
 */
export const BATCH_STORIES_MARKER = "<!-- infinitary-batch-stories -->";

/** Deliberately plain, escaped author prose; general card HTML is never scraped or exported. */
export function presentationHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
/**
 * Author prose as inert Markdown: no markup, and no line that GitLab runs as
 * a quick action (`/merge`, `/close`) when it saves the description; `\/`
 * renders as `/` on both hosts (INF-290 F2).
 */
export function presentationMarkdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~/-]/g, "\\$&")
    .replaceAll("\n", " ");
}
