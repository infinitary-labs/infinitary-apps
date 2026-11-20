import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A merge card body shaped like the one that could not open (INF-3887's
 * cause): a story's words and tables, a still drawing, a scripted map view,
 * and the host's live validation section with each proof transcript kept
 * inline, the same transcripts repeated across rows. The transcripts are
 * real files of this project, read as they are, standing in for that card's
 * private proof logs. Its served markup is over the window's mount limit.
 */
export const OVERSIZED_CARD = {
  title: "Keep the task record readable after a restart",
  words: "The task record keeps every saved reading after the app restarts.",
  drawing: "Two parts and the link between them",
  mapDrawn: "The map view drew itself",
} as const;

const asText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The host's live validation section as it built that card
 * (`validationCard`, src/core/forge/presentationValidation.ts): one row per
 * scenario, each proof transcript kept inline in a disclosure.
 */
function validationSection(logs: { description: string; path: string }[]): string {
  const proof = logs
    .map(
      (log) =>
        `<details><summary>${log.description}</summary><pre>${asText(readFileSync(resolve(log.path), "utf8"))}</pre></details>`,
    )
    .join("");
  const rows = ["reopen", "restart", "upgrade", "second-window"]
    .map(
      (id, n) =>
        `<tr data-validation-scenario="${id}"><td style="vertical-align:top">Reopen the task record, case ${n + 1}</td>` +
        '<td style="vertical-align:top;font-family:var(--font-mono)"><span aria-hidden="true" style="color:var(--ok)">✓</span> Passed live</td>' +
        `<td style="vertical-align:top"><p>The saved reading was still there.</p>${proof}</td></tr>`,
    )
    .join("");
  return (
    "<section data-live-validation><p><strong>Live validation:</strong> 4 of 4 scenarios passed live.</p>" +
    '<table style="width:100%;table-layout:fixed;overflow-wrap:anywhere"><thead><tr><th scope="col">Scenario</th>' +
    `<th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

export function oversizedMergeCardBody(): string {
  const section = validationSection([
    { description: "The journey's run log", path: "docs/card-authoring.md" },
    { description: "The story check's output", path: "docs/forge.md" },
  ]);
  return [
    "<h3>Why</h3>",
    "<p>A restart lost the readings a task had saved.</p>",
    "<h3>What changed</h3>",
    `<ul><li>${OVERSIZED_CARD.words}</li></ul>`,
    "<h3>Before</h3><p>The record was empty after a restart.</p>",
    "<h3>After</h3>",
    "<table><thead><tr><th>Check</th><th>Result</th></tr></thead>",
    "<tbody><tr><td>Restart and reopen</td><td>Reading kept</td></tr></tbody></table>",
    `<figure aria-label="${OVERSIZED_CARD.drawing}"><svg viewBox="0 0 750 60" width="100%">`,
    '<rect x="1" y="10" width="160" height="40" rx="6" fill="var(--bg-2)" stroke="var(--line-2)"/>',
    '<text x="81" y="35" text-anchor="middle" fill="var(--fg-1)">Task record</text>',
    '<line x1="161" y1="30" x2="300" y2="30" stroke="var(--accent)"/>',
    '<rect x="300" y="10" width="160" height="40" rx="6" fill="var(--bg-2)" stroke="var(--line-2)"/>',
    '<text x="380" y="35" text-anchor="middle" fill="var(--fg-1)">Saved readings</text>',
    `</svg><figcaption>${OVERSIZED_CARD.drawing}</figcaption></figure>`,
    '<figure data-map=""><p data-map-drawn=""></p><figcaption>What the change moves</figcaption></figure>',
    `<script>document.querySelector("[data-map-drawn]").textContent = ${JSON.stringify(OVERSIZED_CARD.mapDrawn)};</script>`,
    "<h3>Checked</h3>",
    section,
  ].join("");
}
