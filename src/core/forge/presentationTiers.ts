import { TIERED_STORY_HEADINGS } from "@shared/cardHeadings";
import type { ChangePresentation, RetainedPresentationMedia } from "@shared/changePresentation";
import { fillMapPart } from "@shared/mapPart";
import {
  hostedPresentation,
  nativePresentationMedia,
  presentationFormat,
} from "@shared/presentationDestination";
import { RISK_DIMENSIONS, RISK_WORDS } from "@shared/risk";
import {
  presentationHtmlText as html,
  presentationMarkdownText as md,
  presentationRegionMarkers,
} from "./presentationText";
import { validationCard, validationMarkdown } from "./presentationValidation";
import { githubAttachmentUrl } from "./providers/github/attachments";
import { gitlabAttachmentUrl } from "./providers/gitlab/attachments";

type View = ChangePresentation["views"][number];
/** Pair the two states of a view, never two native recording players. */
function picturesOnly(story: ChangePresentation, view: View): boolean {
  return [...view.before, ...view.after].every((entry) =>
    story.assets.find((asset) => asset.id === entry.asset)?.mediaType.startsWith("image/"),
  );
}
function riskLine(story: ChangePresentation): string {
  const raised = RISK_DIMENSIONS.filter((key) => story.risk[key].level !== "low");
  return raised.length
    ? `Risk above low: ${raised.map((key) => `${RISK_WORDS[key].label}, ${story.risk[key].level} — ${story.risk[key].why}`).join("; ")}`
    : "Risk: low in every dimension.";
}

/** The public record keeps commands and the full assessment behind explicit folds. */
export const CARD_ONLY_MEDIA_WORDS =
  "Pictures and recordings are retained on the card; this host receives the story's text only.";

export function tieredPresentationMarkdown(
  story: ChangePresentation,
  urls: ReadonlyMap<string, string>,
): string {
  if (!hostedPresentation(story.destination))
    throw new Error("This story has no remote description.");
  const host = presentationFormat(story.destination);
  const native = nativePresentationMedia(story.destination);
  const media = (entry: RetainedPresentationMedia, paired: boolean): string => {
    const asset = story.assets.find((candidate) => candidate.id === entry.asset);
    if (!native) return md(entry.alt);
    const url =
      host === "github"
        ? githubAttachmentUrl(urls.get(entry.asset))
        : gitlabAttachmentUrl(urls.get(entry.asset));
    if (!asset || !url) throw new Error("The story has an unconfirmed attachment.");
    if (asset.mediaType === "video/mp4")
      return host === "github" ? `${url}\n\n${md(entry.alt)}` : `![${md(entry.alt)}](${url})`;
    return paired
      ? `<a href="${url}"><img src="${url}" alt="${html(entry.alt)}" width="320"></a>`
      : `![${md(entry.alt)}](${url})`;
  };
  const views = story.views
    .map((view) => {
      // A map view's one picture stands for the drawing the pull request cannot run.
      if (view.map !== undefined)
        return [`### ${md(view.caption)}`, ...view.after.map((entry) => media(entry, false))].join(
          "\n\n",
        );
      const paired = native && view.kind === "changed" && picturesOnly(story, view);
      const adjacentNew =
        native && view.kind === "new" && view.layout === "adjacent" && picturesOnly(story, view);
      const state = (role: "before" | "after") => {
        const cells = view[role].map((entry) => media(entry, paired || adjacentNew));
        return adjacentNew
          ? `<table><tr>${cells.map((cell) => `<td width="50%">\n\n${cell}\n\n</td>`).join("")}</tr></table>`
          : cells.join("\n\n");
      };
      return [
        `### ${view.kind === "new" ? "New: " : ""}${md(view.caption)}`,
        paired
          ? `<table><tr><th>Before</th><th>After</th></tr><tr><td width="50%">\n\n${state("before")}\n\n</td><td width="50%">\n\n${state("after")}\n\n</td></tr></table>`
          : [
              view.before.length ? `**Before**\n\n${state("before")}` : "",
              `**After**\n\n${state("after")}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
      ].join("\n\n");
    })
    .join("\n\n");
  const fold = (title: string, body: string) =>
    body ? `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>` : "";
  const actions = story.requiredActions
    .map((action) =>
      [
        `### ${md(action.title)}`,
        `For: ${md(action.target)}`,
        md(action.consequence),
        action.instructions.map((line, index) => `${index + 1}. ${md(line)}`).join("\n"),
        `Complete when: ${md(action.criterion)}`,
        action.prerequisites.length
          ? `Prerequisites: ${action.prerequisites.map(md).join(", ")}`
          : "",
        action.completion.kind === "manual"
          ? `Confirmation: ${md(action.completion.label)}`
          : `Required device version: ${md(action.completion.deviceId)} ${md(action.completion.minVersion)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
  const { start, end } = presentationRegionMarkers(story.taskId);
  return [
    start,
    `## ${TIERED_STORY_HEADINGS[0]}`,
    story.why.map(md).join("\n\n"),
    `## ${TIERED_STORY_HEADINGS[1]}`,
    story.whatChanged.map((line) => `- ${md(line)}`).join("\n"),
    `## ${TIERED_STORY_HEADINGS[2]}`,
    `**Before:** ${story.before.map(md).join(" ")}\n\n**After:** ${story.after.map(md).join(" ")}`,
    !native && story.views.length ? CARD_ONLY_MEDIA_WORDS : "",
    views,
    story.noPicture ? md(story.noPicture) : "",
    `## ${TIERED_STORY_HEADINGS[3]}`,
    validationMarkdown(story.liveValidation),
    story.checked?.map((item) => `- [x] ${md(item.check)}: ${md(item.result)}`).join("\n"),
    fold("How it was checked", story.verification.map(md).join("\n\n")),
    "### Risk",
    md(riskLine(story)),
    fold(
      "Full risk assessment",
      [
        "| Dimension | Level | Why |",
        "| --- | --- | --- |",
        ...RISK_DIMENSIONS.map(
          (key) =>
            `| ${RISK_WORDS[key].label} | ${story.risk[key].level} | ${md(story.risk[key].why)} |`,
        ),
      ].join("\n"),
    ),
    actions ? `## Required actions\n\n${actions}` : "",
    fold("Not done", story.unfinished.map(md).join("\n\n")),
    end,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The glance shares every fact and file with the public record, not its risk
 * table. `mapPart` is the map part a map view draws in live; without it the
 * view shows its picture.
 */
export function tieredPresentationCardBody(story: ChangePresentation, mapPart?: string): string {
  const paragraphs = (lines: string[]) => lines.map((line) => `<p>${html(line)}</p>`).join("\n");
  const assetUrl = (id: string) => {
    const asset = story.assets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error("The story has missing retained media.");
    return `app-frame://${asset.mediaType === "video/mp4" ? "media" : "images"}/${asset.file}`;
  };
  const media = (entry: RetainedPresentationMedia) => {
    const asset = story.assets.find((candidate) => candidate.id === entry.asset);
    const poster = story.assets.find((candidate) => candidate.id === (entry.poster ?? entry.asset));
    if (!asset || !poster) throw new Error("The story has missing retained media.");
    if (entry.poster && !asset.durationMs)
      throw new Error("The recording's measured duration is missing.");
    const demo = entry.poster
      ? ` data-inf-demo="${assetUrl(entry.asset)}" data-inf-demo-duration="${asset.durationMs}"`
      : "";
    return `<figure${demo} style="margin:0"><img src="${assetUrl(entry.poster ?? entry.asset)}" alt="${html(entry.alt)}" width="${poster.width}" height="${poster.height}"></figure>`;
  };
  // INF-706 (approved table): one boxed table per view, its caption above,
  // Before and After only in the header, and the matching pictures in a row.
  const LINE = "1px solid var(--line-1)";
  // The frame stylesheet's New tag, as words in the header rather than over a corner.
  const NEW_TAG =
    '<span style="display:inline-block;padding:1px var(--space-1);font-family:var(--font-mono);font-size:var(--text-xs);font-weight:400;color:var(--fg-1);background:var(--accent-dim);border:1px solid var(--accent);border-radius:var(--radius-s)">New</span>';
  const table = (head: string, rows: (RetainedPresentationMedia | undefined)[][]) => {
    const cell = (entry: RetainedPresentationMedia | undefined, column: number, last: boolean) =>
      `<td style="vertical-align:top${column ? `;border-left:${LINE}` : ""}${last ? ";border-bottom:0" : ""}">${entry ? media(entry) : ""}</td>`;
    const body = rows
      .map(
        (row, index) =>
          `<tr>${row.map((entry, column) => cell(entry, column, index === rows.length - 1)).join("")}</tr>`,
      )
      .join("");
    return `<table style="table-layout:fixed;border-collapse:separate;border-spacing:0;border:${LINE};border-radius:var(--radius-m);overflow:hidden"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };
  const views = story.views
    .map((view) => {
      if (view.map !== undefined) {
        const drawing = mapPart
          ? fillMapPart(mapPart, view.map, true)
          : table('<th scope="col">After</th>', [view.after]);
        return `<section><p>${html(view.caption)}</p>${drawing}</section>`;
      }
      if (view.kind === "new") {
        const columns = view.layout === "adjacent" ? 2 : 1;
        const rows = Array.from({ length: Math.ceil(view.after.length / columns) }, (_, index) =>
          view.after.slice(index * columns, index * columns + columns),
        );
        return `<section><p>${html(view.caption)}</p>${table(`<th scope="colgroup" colspan="${columns}">${NEW_TAG}</th>`, rows)}</section>`;
      }
      const rows = Array.from(
        { length: Math.max(view.before.length, view.after.length) },
        (_, index) => [view.before[index], view.after[index]],
      );
      return `<section><p>${html(view.caption)}</p>${table(`<th scope="col">Before</th><th scope="col" style="border-left:${LINE}">After</th>`, rows)}</section>`;
    })
    .join("\n");
  const fold = (title: string, lines: string[]) =>
    lines.length ? `<details><summary>${title}</summary>${paragraphs(lines)}</details>` : "";
  return [
    `<h3>${TIERED_STORY_HEADINGS[0]}</h3>`,
    paragraphs(story.why),
    `<h3>${TIERED_STORY_HEADINGS[1]}</h3>`,
    // The crewmate's own picture-first account replaces the bullets on the
    // card; the pull request and the squash message keep the bullets.
    story.whatChangedPart ??
      `<ul>${story.whatChanged.map((line) => `<li>${html(line)}</li>`).join("")}</ul>`,
    `<h3>${TIERED_STORY_HEADINGS[2]}</h3>`,
    `<p><strong>Before:</strong> ${story.before.map(html).join(" ")}</p>`,
    `<p><strong>After:</strong> ${story.after.map(html).join(" ")}</p>`,
    views,
    story.noPicture ? `<p data-inf-no-picture>${html(story.noPicture)}</p>` : "",
    `<h3>${TIERED_STORY_HEADINGS[3]}</h3>`,
    validationCard(story.liveValidation),
    `<ul style="list-style:none;padding-left:0">${story.checked?.map((item) => `<li><span aria-hidden="true" style="color:var(--ok)">✓</span> ${html(item.check)}: ${html(item.result)}</li>`).join("") ?? ""}</ul>`,
    fold("How it was checked", story.verification),
    fold("Not done", story.unfinished),
  ]
    .filter(Boolean)
    .join("\n");
}
