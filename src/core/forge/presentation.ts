import { createHash } from "node:crypto";
import type {
  ChangePresentation,
  RetainedPresentationMedia,
  StoryAround,
} from "@shared/changePresentation";
import { RISK_DIMENSIONS, RISK_WORDS } from "@shared/risk";
import type { AttachmentMediaType } from "./attachments";
import {
  presentationMarkdownText as markdown,
  presentationHtmlText,
  presentationRegionMarkers,
} from "./presentationText";
import { tieredPresentationCardBody, tieredPresentationMarkdown } from "./presentationTiers";
import { githubAttachmentUrl } from "./providers/github/attachments";
import { gitlabAttachmentName, gitlabAttachmentUrl } from "./providers/gitlab/attachments";

export {
  presentationHtmlText,
  presentationMarkdownText,
  presentationRegionMarkers,
} from "./presentationText";

const versionWords = (story: ChangePresentation) =>
  `Story ${story.revision} · demonstrated version ${story.head}`;

/**
 * Each host's own native forms (INF-132); a receipt never crosses hosts.
 * GitHub plays a bare attachment URL in its own player and signs private
 * media; GitLab plays an image link to an MP4 in its own player, and its
 * project-relative reference resolves inside the merge request's project.
 */
const NATIVE = {
  "github.com": {
    url: githubAttachmentUrl,
    /** The bare URL carries no words, so its alt text follows as its own paragraph. */
    recording: (url: string) => url,
    altParagraph: true,
    /** GitHub's description limit, prose, links, project text and human words included. */
    bodyLimit: 65_536,
    // Only for sizing: every accepted receipt has this fixed-length UUID shape.
    sizingUrl: (_mediaType: AttachmentMediaType) =>
      "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
  },
  "gitlab.com": {
    url: gitlabAttachmentUrl,
    recording: (url: string, alt: string) => `![${markdown(alt)}](${url})`,
    altParagraph: false,
    /** GitLab's merge request description limit. */
    bodyLimit: 1_048_576,
    sizingUrl: (mediaType: AttachmentMediaType) =>
      `/uploads/${"0".repeat(32)}/${gitlabAttachmentName(mediaType)}`,
  },
} as const;

/** The most characters the host keeps in a whole description. */
export function presentationBodyLimit(host: ChangePresentation["destination"]["host"]): number {
  return NATIVE[host].bodyLimit;
}

/** An address of a real receipt's length, for sizing a description before any upload. */
export function presentationSizingUrl(
  host: ChangePresentation["destination"]["host"],
  mediaType: AttachmentMediaType,
): string {
  return NATIVE[host].sizingUrl(mediaType);
}

/** Native players ignore requested widths; only picture-only pairs can safely sit side by side. */
function adjacentPictures(
  story: ChangePresentation,
  view: ChangePresentation["views"][number],
  role: "before" | "after",
): boolean {
  return (
    view.layout === "adjacent" &&
    view[role].every((entry) =>
      story.assets.find((asset) => asset.id === entry.asset)?.mediaType.startsWith("image/"),
    )
  );
}

/** Recordings use each host's own native player; GitHub's also signs private media. */
function legacyPresentationMarkdown(
  story: ChangePresentation,
  urls: ReadonlyMap<string, string>,
  checks: "pending" | "passed",
): string {
  const native = NATIVE[story.destination.host];
  const media = (
    entry: RetainedPresentationMedia,
    caption: string,
    isNew: boolean,
    adjacent = false,
  ) => {
    const asset = story.assets.find((candidate) => candidate.id === entry.asset);
    const url = native.url(urls.get(entry.asset));
    if (!asset || !url) throw new Error("The story has an unconfirmed attachment.");
    const shown =
      asset.mediaType === "video/mp4"
        ? native.recording(url, entry.alt)
        : adjacent
          ? `<a href="${url}"><img src="${url}" alt="${presentationHtmlText(entry.alt)}" width="320"></a>`
          : `![${markdown(entry.alt)}](${url})`;
    return [
      isNew ? "**New**" : "",
      shown,
      markdown(caption),
      asset.mediaType === "video/mp4" && native.altParagraph ? markdown(entry.alt) : "",
      entry.applicability ? `Evidence applicability: ${markdown(entry.applicability)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  const paragraphs = (lines: string[]) => lines.map(markdown).join("\n\n");
  const views = (role: "before" | "after") =>
    story.views
      .map((view) => {
        if (!view[role].length) return "";
        const adjacent = adjacentPictures(story, view, role);
        const cells = view[role].map((entry) =>
          media(entry, view.caption, view.kind === "new", adjacent),
        );
        return adjacent
          ? `<table><tr>\n${cells.map((cell) => `<td width="50%">\n\n${cell}\n\n</td>`).join("\n")}\n</tr></table>`
          : cells.join("\n\n");
      })
      .join("\n\n");
  const actions = story.requiredActions
    .map((action) =>
      [
        `### ${markdown(action.title)}`,
        `For: ${markdown(action.target)}`,
        markdown(action.consequence),
        action.instructions.map((line, index) => `${index + 1}. ${markdown(line)}`).join("\n"),
        `Complete when: ${markdown(action.criterion)}`,
        action.prerequisites.length
          ? `Prerequisites: ${action.prerequisites.map(markdown).join(", ")}`
          : "",
        action.completion.kind === "manual"
          ? `Confirmation: ${markdown(action.completion.label)}`
          : `Required device version: ${markdown(action.completion.deviceId)} ${markdown(action.completion.minVersion)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
  const { start, end } = presentationRegionMarkers(story.taskId);
  return [
    start,
    "## Why",
    paragraphs(story.why),
    "## What changed",
    paragraphs(story.whatChanged),
    "## Before",
    paragraphs(story.before),
    views("before"),
    "## After",
    paragraphs(story.after),
    views("after"),
    story.noPicture ? `No pictures: ${markdown(story.noPicture)}` : "",
    "### Verified",
    paragraphs(story.verification),
    checks === "pending"
      ? "Checks are pending at this publication."
      : "The checks passed for this version at publication.",
    versionWords(story),
    "### Risk",
    [
      "| Dimension | Level | Why |",
      "| --- | --- | --- |",
      ...RISK_DIMENSIONS.map(
        (dimension) =>
          `| ${RISK_WORDS[dimension].label} | ${story.risk[dimension].level} | ${markdown(story.risk[dimension].why)} |`,
      ),
    ].join("\n"),
    "### Required actions",
    actions || "None.",
    "### Not done",
    story.unfinished.length ? paragraphs(story.unfinished) : "Nothing remains.",
    end,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Saved version-one stories keep their drawing; new stories share the two-tier reading. */
export function presentationMarkdown(
  story: ChangePresentation,
  urls: ReadonlyMap<string, string>,
  checks: "pending" | "passed",
): string {
  return story.version === 1
    ? legacyPresentationMarkdown(story, urls, checks)
    : tieredPresentationMarkdown(story, urls);
}
export function presentationCardBody(story: ChangePresentation): string {
  return story.version === 1
    ? legacyPresentationCardBody(story)
    : tieredPresentationCardBody(story);
}

/** INF-228 F2: a squash carries the author's summary, not the evidence presentation. */
export function presentationCommitMessage(
  story: Pick<ChangePresentation, "whatChanged" | "projectText">,
): string {
  // Conventional footers are structured project text, not scraped rendered Markdown.
  // Keep their continuation lines so the release reader and people retain the full warning.
  const footer = /^BREAKING[ -]CHANGE:[^\r\n]*(?:\r?\n[^\r\n]+)*/m.exec(story.projectText)?.[0];
  return [...story.whatChanged, ...(footer ? [footer.replaceAll("\r\n", "\n")] : [])].join("\n\n");
}

/** The exact same story; CardService keeps the risk chart, requirements and merge controls. */
function legacyPresentationCardBody(story: ChangePresentation): string {
  const text = presentationHtmlText;
  const paragraphs = (lines: string[]) => lines.map((line) => `<p>${text(line)}</p>`).join("\n");
  const assetUrl = (id: string) => {
    const asset = story.assets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error("The story has missing retained media.");
    return `app-frame://${asset.mediaType === "video/mp4" ? "media" : "images"}/${asset.file}`;
  };
  const views = (role: "before" | "after") =>
    story.views
      .map((view) => {
        const figures = view[role]
          .map((entry) => {
            const asset = story.assets.find((candidate) => candidate.id === entry.asset);
            const poster = story.assets.find(
              (candidate) => candidate.id === (entry.poster ?? entry.asset),
            );
            if (!asset || !poster) throw new Error("The story has missing retained media.");
            if (entry.poster && !asset.durationMs)
              throw new Error("The recording's measured duration is missing.");
            const demo = entry.poster
              ? ` data-inf-demo="${assetUrl(entry.asset)}" data-inf-demo-duration="${asset.durationMs}"`
              : "";
            return `<figure${view.kind === "new" ? " data-inf-new" : ""}${demo}><img src="${assetUrl(entry.poster ?? entry.asset)}" alt="${text(entry.alt)}" width="${poster.width}" height="${poster.height}"><figcaption>${text(view.caption)}</figcaption></figure>${entry.applicability ? `<p>Evidence applicability: ${text(entry.applicability)}</p>` : ""}`;
          })
          .join("\n");
        return figures && adjacentPictures(story, view, role)
          ? `<div class="inf-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">${figures}</div>`
          : figures;
      })
      .join("\n");
  return [
    "<h3>Why</h3>",
    paragraphs(story.why),
    "<h3>What changed</h3>",
    paragraphs(story.whatChanged),
    "<h3>Before</h3>",
    paragraphs(story.before),
    views("before"),
    "<h3>After</h3>",
    paragraphs(story.after),
    views("after"),
    story.noPicture ? `<p data-inf-no-picture>${text(story.noPicture)}</p>` : "",
    "<h4>Verified</h4>",
    paragraphs(story.verification),
    `<p class="inf-mono">${text(versionWords(story))}</p>`,
    story.unfinished.length ? `<h4>Not done</h4>${paragraphs(story.unfinished)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A host's web editor changes line endings, not the person's words. */
export const presentationLines = (text: string): string => text.replaceAll("\r\n", "\n");

/** Missing or duplicate boundaries make the whole body the text a person must review. */
function presentationBounds(
  body: string,
  taskId: string,
): { first: number; end: number } | undefined {
  const { start, end } = presentationRegionMarkers(taskId);
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (
    first < 0 ||
    last < first ||
    body.indexOf(start, first + start.length) >= 0 ||
    body.indexOf(end, last + end.length) >= 0
  )
    return undefined;
  return { first, end: last + end.length };
}

/** Read the exact review text, including the whole body when its boundaries were edited. */
export function readPresentationRegion(body: string, taskId: string): string {
  body = presentationLines(body);
  const bounds = presentationBounds(body, taskId);
  return bounds ? body.slice(bounds.first, bounds.end) : body;
}

/** Preserve surrounding words and normalize web-editor line endings. */
export function replacePresentationRegion(
  body: string,
  previous: string,
  next: string,
  taskId: string,
): string {
  body = presentationLines(body);
  previous = presentationLines(previous);
  next = presentationLines(next);
  const bounds = presentationBounds(body, taskId);
  const old = readPresentationRegion(body, taskId);
  if (old !== previous)
    throw new Error(`Someone edited the generated story. Show the captain the saved story and this current ${bounds ? "region" : "whole description"} on a card; only after a deliberate republish choice pass this exact text as recovery.replaceRegion.${bounds ? "" : " Its markers are missing or duplicated: republishing keeps all existing text, removes only this story's marker comments and appends a restored generated section."}
${old}`);
  if (bounds) return body.slice(0, bounds.first) + next + body.slice(bounds.end);
  // With no unambiguous boundary, no prose is ours to delete. Restore one
  // marked section while retaining even the old story's unmarked words.
  const { start, end } = presentationRegionMarkers(taskId);
  const preserved = body.replaceAll(start, "").replaceAll(end, "");
  return [preserved, next].filter(Boolean).join("\n\n");
}

/** INF-497: a passage around the story was not changed; the words are the crewmate's whole answer. */
export class PresentationAroundError extends Error {}

/** The words a project template or a person keeps above and below the story; none without whole markers. */
export function presentationAround(
  body: string,
  taskId: string,
): { above: string; below: string } | undefined {
  body = presentationLines(body);
  const bounds = presentationBounds(body, taskId);
  return bounds && { above: body.slice(0, bounds.first), below: body.slice(bounds.end) };
}

/** Whether a description read back keeps the words around the story it was sent with. */
export function sameAroundPresentation(read: string, sent: string, taskId: string): boolean {
  const held = presentationAround(read, taskId);
  const wanted = presentationAround(sent, taskId);
  return (
    held !== undefined &&
    wanted !== undefined &&
    held.above.trim() === wanted.above.trim() &&
    held.below.trim() === wanted.below.trim()
  );
}

const aroundWords = ({ above, below }: { above: string; below: string }) =>
  `Above the story:\n${above.trim() || "(nothing)"}\nBelow the story:\n${below.trim() || "(nothing)"}`;

/**
 * INF-497: change one exact passage of the words around the story, in place.
 * The story's own region never moves or changes. A passage someone changed
 * since the crewmate read it is no longer there, so nothing is sent and the
 * answer quotes the words as they are now. On GitLab no line of the new words
 * starts a quick action (`/merge`, `/close`): only the captain's click merges.
 */
export function replaceAroundPresentation(
  body: string,
  around: StoryAround,
  taskId: string,
  quickActions: boolean,
): string {
  body = presentationLines(body);
  const bounds = presentationBounds(body, taskId);
  if (!bounds)
    throw new PresentationAroundError(
      "Nothing was sent: the story's markers are missing or duplicated, so the words around it cannot be told from the story. Republish the story first.",
    );
  const parts = { above: body.slice(0, bounds.first), below: body.slice(bounds.end) };
  const story = body.slice(bounds.first, bounds.end);
  const from = presentationLines(around.from);
  const to = quickActions
    ? presentationLines(around.to).replace(/^([ \t]*)\//gm, "$1\\/")
    : presentationLines(around.to);
  if (from === "") {
    if (`${parts.above}${parts.below}`.trim())
      throw new PresentationAroundError(
        `Nothing was sent: an empty around.from adds words only when nothing surrounds the story. Name the passage you change; the words around the story read now:\n${aroundWords(parts)}`,
      );
    return [to, story].filter(Boolean).join("\n\n");
  }
  const count = (text: string) => text.split(from).length - 1;
  const found = count(parts.above) + count(parts.below);
  if (found === 0)
    throw new PresentationAroundError(
      `Nothing was sent: the words around the story no longer hold around.from exactly; someone may have changed them since you read them. They read now:\n${aroundWords(parts)}`,
    );
  if (found > 1)
    throw new PresentationAroundError(
      `Nothing was sent: around.from appears ${found} times around the story. Quote more of it so it names one place.`,
    );
  // A replacer function: the new words are text, never `$&` patterns.
  return count(parts.above) > 0
    ? `${parts.above.replace(from, () => to)}${story}${parts.below}`
    : `${parts.above}${story}${parts.below.replace(from, () => to)}`;
}

/** Bind a kept approval to its content, independently of the demonstrated version. */
export function presentationContentHash(story: ChangePresentation): string {
  const { head: _head, revision: _revision, ...content } = story;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
