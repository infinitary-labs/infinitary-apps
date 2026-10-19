import { TIERED_STORY_HEADINGS } from "@shared/cardHeadings";
import type { ChangePresentation, RetainedPresentationMedia } from "@shared/changePresentation";
import { RISK_DIMENSIONS, RISK_WORDS } from "@shared/risk";
import {
  presentationHtmlText as html,
  presentationMarkdownText as md,
  presentationRegionMarkers,
} from "./presentationText";
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
export function tieredPresentationMarkdown(
  story: ChangePresentation,
  urls: ReadonlyMap<string, string>,
): string {
  const host = story.destination.host;
  const media = (entry: RetainedPresentationMedia, paired: boolean): string => {
    const asset = story.assets.find((candidate) => candidate.id === entry.asset);
    const url =
      host === "github.com"
        ? githubAttachmentUrl(urls.get(entry.asset))
        : gitlabAttachmentUrl(urls.get(entry.asset));
    if (!asset || !url) throw new Error("The story has an unconfirmed attachment.");
    if (asset.mediaType === "video/mp4")
      return host === "github.com" ? `${url}\n\n${md(entry.alt)}` : `![${md(entry.alt)}](${url})`;
    return paired
      ? `<a href="${url}"><img src="${url}" alt="${html(entry.alt)}" width="320"></a>`
      : `![${md(entry.alt)}](${url})`;
  };
  const views = story.views
    .map((view) => {
      const paired = view.kind === "changed" && picturesOnly(story, view);
      const adjacentNew =
        view.kind === "new" && view.layout === "adjacent" && picturesOnly(story, view);
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
    views,
    story.noPicture ? md(story.noPicture) : "",
    `## ${TIERED_STORY_HEADINGS[3]}`,
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

/** The glance shares every fact and file with the public record, not its risk table. */
export function tieredPresentationCardBody(story: ChangePresentation): string {
  const paragraphs = (lines: string[]) => lines.map((line) => `<p>${html(line)}</p>`).join("\n");
  const assetUrl = (id: string) => {
    const asset = story.assets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error("The story has missing retained media.");
    return `app-frame://${asset.mediaType === "video/mp4" ? "media" : "images"}/${asset.file}`;
  };
  const media = (entry: RetainedPresentationMedia, role: string) => {
    const asset = story.assets.find((candidate) => candidate.id === entry.asset);
    const poster = story.assets.find((candidate) => candidate.id === (entry.poster ?? entry.asset));
    if (!asset || !poster) throw new Error("The story has missing retained media.");
    if (entry.poster && !asset.durationMs)
      throw new Error("The recording's measured duration is missing.");
    const demo = entry.poster
      ? ` data-inf-demo="${assetUrl(entry.asset)}" data-inf-demo-duration="${asset.durationMs}"`
      : "";
    return `<figure${demo}><img src="${assetUrl(entry.poster ?? entry.asset)}" alt="${html(entry.alt)}" width="${poster.width}" height="${poster.height}"><figcaption>${role}</figcaption></figure>`;
  };
  const views = story.views
    .map((view) => {
      const paired =
        (view.kind === "changed" || view.layout === "adjacent") && picturesOnly(story, view);
      const states = (role: "before" | "after") =>
        view[role].map((entry) => media(entry, role === "before" ? "Before" : "After")).join("\n");
      return `<section${view.kind === "new" ? " data-inf-new" : ""}><p>${view.kind === "new" ? "New: " : ""}${html(view.caption)}</p><div${paired ? ' class="inf-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"' : ""}>${view.before.length ? `<div>${states("before")}</div><div>${states("after")}</div>` : states("after")}</div></section>`;
    })
    .join("\n");
  const fold = (title: string, lines: string[]) =>
    lines.length ? `<details><summary>${title}</summary>${paragraphs(lines)}</details>` : "";
  return [
    `<h3>${TIERED_STORY_HEADINGS[0]}</h3>`,
    paragraphs(story.why),
    `<h3>${TIERED_STORY_HEADINGS[1]}</h3>`,
    `<ul>${story.whatChanged.map((line) => `<li>${html(line)}</li>`).join("")}</ul>`,
    `<h3>${TIERED_STORY_HEADINGS[2]}</h3>`,
    `<p><strong>Before:</strong> ${story.before.map(html).join(" ")}</p>`,
    `<p><strong>After:</strong> ${story.after.map(html).join(" ")}</p>`,
    views,
    story.noPicture ? `<p data-inf-no-picture>${html(story.noPicture)}</p>` : "",
    `<h3>${TIERED_STORY_HEADINGS[3]}</h3>`,
    `<ul style="list-style:none;padding-left:0">${story.checked?.map((item) => `<li><span aria-hidden="true" style="color:var(--ok)">✓</span> ${html(item.check)}: ${html(item.result)}</li>`).join("") ?? ""}</ul>`,
    fold("How it was checked", story.verification),
    fold("Not done", story.unfinished),
  ]
    .filter(Boolean)
    .join("\n");
}
