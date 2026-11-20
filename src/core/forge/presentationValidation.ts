import { fileSizeWords } from "@shared/attachments";
import { cardLogUrl, parseCardLogFileName } from "@shared/cardPictures";
import type { LiveValidationSummary } from "@shared/liveValidationSummary";
import { liveValidationLine } from "@shared/liveValidationSummary";
import { presentationHtmlText as html, presentationMarkdownText as md } from "./presentationText";

export function validationMarkdown(summary: LiveValidationSummary | undefined): string {
  if (!summary) return "";
  const mark = (result: string) =>
    result === "Passed live" ? "✅" : result === "Failed" ? "❌" : "⏸";
  return [
    `**Live validation:** ${md(liveValidationLine(summary))}`,
    ...(summary.rows.length
      ? [
          [
            "| Scenario | Result | Evidence |",
            "| --- | --- | --- |",
            ...summary.rows.map(
              (row) =>
                `| ${md(row.action)}${row.supplementary ? " (supplementary)" : ""} | ${mark(row.result)} ${md(row.result)} | ${md(row.reason)} |`,
            ),
          ].join("\n"),
        ]
      : []),
  ].join("\n\n");
}

/**
 * Files stay private to the app. Pictures and recordings open in the picture
 * viewer from a disclosure, as before. A kept text transcript is one line, its
 * name and size, that opens it in the log reader over the card: its text is
 * never written into the card (INF-3887: 37 pasted logs made a merge card
 * 1,383,135 characters long, past what the window opens).
 */
export function validationCard(summary: LiveValidationSummary | undefined): string {
  if (!summary) return "";
  const proof = (row: LiveValidationSummary["rows"][number]) =>
    row.evidence
      .map((item) => {
        if (!item.picture && !item.media) {
          const size = `<span style="color:var(--fg-3);font-family:var(--font-mono);font-size:var(--text-xs)">${html(fileSizeWords(item.bytes))}</span>`;
          const name = parseCardLogFileName(item.file)
            ? `<button type="button" data-inf-log="${html(cardLogUrl(item.file))}" data-inf-log-bytes="${item.bytes}">${html(item.description)}</button>`
            : html(item.description);
          return `<p style="margin:var(--space-1) 0">${name} ${size}</p>`;
        }
        const image = item.picture
          ? `<img src="${html(item.picture)}" alt="${html(item.description)}">`
          : "";
        const demo =
          item.media && item.picture
            ? ` data-inf-demo="${html(item.media)}"${item.durationMs ? ` data-inf-demo-duration="${item.durationMs}"` : ""}`
            : "";
        return `<details><summary>${html(item.description)}</summary><figure${demo}>${image}<figcaption>${html(item.description)}</figcaption></figure></details>`;
      })
      .join("");
  const approvals = summary.approvals?.length
    ? `<details><summary>Validation approvals</summary><ul>${summary.approvals.map(({ scenario, source, runs }) => `<li>${html(scenario)}: ${html(source)} · ${runs} ${runs === 1 ? "run" : "runs"}</li>`).join("")}</ul></details>`
    : "";
  return `<section data-live-validation><p><strong>Live validation:</strong> ${html(liveValidationLine(summary))}</p>${summary.rows.length ? `<table style="width:100%;table-layout:fixed;overflow-wrap:anywhere"><colgroup><col style="width:32%"><col style="width:20%"><col style="width:48%"></colgroup><thead><tr><th scope="col">Scenario</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${summary.rows.map((row) => `<tr data-validation-scenario="${html(row.id)}"><td style="vertical-align:top">${html(row.action)}${row.supplementary ? " (supplementary)" : ""}</td><td style="vertical-align:top;font-family:var(--font-mono)">${row.result === "Passed live" ? '<span aria-hidden="true" style="color:var(--ok)">✓</span> ' : row.result === "Failed" ? '<span aria-hidden="true" style="color:var(--danger)">×</span> ' : ""}${html(row.result)}</td><td style="vertical-align:top"><p>${html(row.reason)}</p>${proof(row)}</td></tr>`).join("")}</tbody></table>` : ""}${approvals}</section>`;
}
