import { versionName } from "../../shared/releaseTracking";
import { isAlphaVersion, isStableVersion, parseSemver } from "../../shared/semver";
import {
  ENTRY_KINDS,
  type EntryKind,
  MAX_HIGHLIGHTS,
  NOTE_AREAS,
  type NoteArea,
  type NoteEntry,
} from "./catalog";
import { listedEntries, type Selection } from "./select";

/**
 * The startup note's Briefing, the design the captain chose on FI3-608 and
 * extended on FI3-745 (docs/release-notes.md "The startup note"): the
 * version range, one line on what it covers, at most three numbered
 * highlights - the first across the card with its hero picture under it, the
 * next two side by side with theirs above - then every change behind one
 * disclosure, grouped by feature area in the product's order, features
 * first, each change tagged with its kind. It is an ordinary card body: the
 * frame's own elements and helper classes, typed catalog data escaped into
 * trusted templates. The catalog never supplies markup.
 */

/**
 * A note that lists changes ends on where to read it again: the Help menu's
 * What’s New, which opens the newest such note (docs/release-notes.md
 * "Reading a note again").
 */
export const READ_AGAIN = "You can read this again from What’s New in the Help menu.";

const KIND_LABEL: Record<EntryKind, string> = {
  feature: "Added",
  improvement: "Improved",
  fix: "Fixed",
  removal: "Removed",
  maintenance: "Maintenance",
};

const NUMBER_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A hero picture the host already copied for the note: what the body names it by, and its size. */
export type ShownPicture = { src: string; width: number; height: number };

/** A highlight's hero pair: both ride the note, and the frame shows the one in the reader's theme. */
export type HeroPicture = { alt: string; dark: ShownPicture; light: ShownPicture };

export type NoteInput = {
  /**
   * `overview`: a first installation's notes for this release alone.
   * `history`: every recorded change, for an earlier version that kept no record.
   */
  mode: "upgrade" | "overview" | "history";
  /** The version last opened; null on a first installation or in `history`. */
  from: string | null;
  to: string;
  selection: Selection;
  /** Highlights' hero pictures, by entry id; a highlight without one reads as text. */
  pictures?: ReadonlyMap<string, HeroPicture>;
};

export type NoteText = { title: string; body: string };

/** The up-to-three highlights: by rank, the newer release first on a tie. */
export function highlights(entries: NoteEntry[]): NoteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.highlight !== undefined)
    .sort((a, b) => (a.entry.highlight ?? 0) - (b.entry.highlight ?? 0) || a.index - b.index)
    .slice(0, MAX_HIGHLIGHTS)
    .map(({ entry }) => entry);
}

function promotion(from: string | null, to: string): boolean {
  if (!from || !isAlphaVersion(from) || !isStableVersion(to)) return false;
  const a = parseSemver(from);
  const b = parseSemver(to);
  return !!a && !!b && a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function rangeLine(input: NoteInput): string {
  const start =
    input.mode === "history"
      ? "An earlier version"
      : input.from === null
        ? "First installation"
        : escapeHtml(capitalized(versionName(input.from)));
  const end = escapeHtml(capitalized(versionName(input.to)));
  const label =
    input.mode === "history"
      ? `From an earlier version to ${versionName(input.to)}`
      : input.from === null
        ? `A first installation of ${versionName(input.to)}`
        : `From ${versionName(input.from)} to ${versionName(input.to)}`;
  return `<p class="inf-mono inf-muted" aria-label="${escapeHtml(label)}">${start} <span aria-hidden="true">→</span> <span style="color:var(--accent)">${end}</span></p>`;
}

const warning = (text: string) =>
  `<p class="inf-panel" style="border-color:var(--warn)">${text}</p>`;

const areaLabel = (area: NoteArea) => NOTE_AREAS.find((item) => item.id === area)?.label ?? area;

/**
 * Each picture sits on a mat - a hairline panel with 12 px of padding on the
 * note's own surface - so a picture of a card keeps one visible edge instead
 * of two. The lead spans the card; the two beside it share one height.
 */
const MAT =
  "box-sizing:border-box;width:100%;padding:var(--space-3);object-fit:contain;background:var(--bg-1);border:1px solid var(--line-1);border-radius:var(--radius-s)";
const LEAD_MAT = `${MAT};max-height:384px;margin:var(--space-2) 0`;
const SIDE_MAT = `${MAT};height:170px;max-height:none;margin:0 0 var(--space-2)`;

/** Both pictures of a pair, each marked with its theme; the frame stylesheet shows the matching one. */
function heroPair(picture: HeroPicture, style: string): string {
  return (["dark", "light"] as const)
    .map((theme) => {
      const shown = picture[theme];
      return `<img src="${escapeHtml(shown.src)}" alt="${escapeHtml(picture.alt)}" width="${shown.width}" height="${shown.height}" data-inf-theme="${theme}" style="${style}">`;
    })
    .join("");
}

function highlight(entry: NoteEntry, index: number, picture: HeroPicture | undefined): string {
  const label = `${String(index + 1).padStart(2, "0")} / ${KIND_LABEL[entry.kind]}${
    entry.area ? ` · ${escapeHtml(areaLabel(entry.area))}` : ""
  }`;
  const words = `<h3>${escapeHtml(entry.title)}</h3>${entry.body ? `<p>${escapeHtml(entry.body)}</p>` : ""}`;
  return index === 0
    ? `<div><h6>${label}</h6>${words}${picture ? heroPair(picture, LEAD_MAT) : ""}</div>`
    : `<div><h6>${label}</h6>${picture ? heroPair(picture, SIDE_MAT) : ""}${words}</div>`;
}

function highlightsBlock(
  top: NoteEntry[],
  pictures: ReadonlyMap<string, HeroPicture> | undefined,
): string {
  const [lead, ...rest] = top;
  if (!lead) return "";
  return `<section aria-label="Highlights" style="border-block:1px solid var(--line-1);padding-top:var(--space-3);margin-bottom:var(--space-3)">${highlight(lead, 0, pictures?.get(lead.id))}${
    rest.length > 0
      ? `<div class="inf-grid" style="grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));column-gap:var(--space-4)">${rest
          .map((entry, index) => highlight(entry, index + 1, pictures?.get(entry.id)))
          .join("")}</div>`
      : ""
  }</section>`;
}

function changeItem(entry: NoteEntry): string {
  return `<li><strong>${escapeHtml(entry.title)}</strong> <small class="inf-mono inf-muted">${KIND_LABEL[entry.kind]}</small>${
    entry.body ? `<br>${escapeHtml(entry.body)}` : ""
  }</li>`;
}

function group(heading: string, entries: NoteEntry[]): string {
  return `<details open><summary>${heading} <span class="inf-muted">· ${count(entries.length, "change", "changes")}</span></summary><ul>${entries
    .map(changeItem)
    .join("")}</ul></details>`;
}

const kindRank = (entry: NoteEntry) => ENTRY_KINDS.indexOf(entry.kind);

/**
 * One disclosure per feature area, in the product's order, skipping empty
 * ones: features first inside each, then improvements, fixes, removals and
 * maintenance, newer releases first within a kind. An entry with no
 * declared area is under Other changes.
 */
function areaGroups(entries: NoteEntry[]): string {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => kindRank(a.entry) - kindRank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  return NOTE_AREAS.map((area) => {
    const inArea = ordered.filter((entry) => (entry.area ?? "other") === area.id);
    return inArea.length > 0 ? group(escapeHtml(area.label), inArea) : "";
  }).join("");
}

/**
 * Every change, by feature area; the range line above already names the
 * versions. A stretch an earlier launch could not verify keeps its own
 * disclosure, grouped by area inside.
 */
function allChanges(selection: Selection, open: boolean): string {
  const total = listedEntries(selection).length;
  const groups = [
    areaGroups(selection.releases.flatMap((release) => release.entries)),
    ...selection.recovered.map(
      (gap) =>
        `<details open><summary>Earlier, now verified: ${escapeHtml(gap.from ? versionName(gap.from) : "an earlier version")} to ${escapeHtml(versionName(gap.to))} <span class="inf-muted">· ${count(gap.entries.length, "change", "changes")}</span></summary>${areaGroups(gap.entries)}</details>`,
    ),
  ];
  return `<details${open ? " open" : ""}><summary>All ${count(total, "change", "changes")}</summary>${groups.join("")}</details>`;
}

/** What the note covers, in one line: the prototype's deck. */
function deck(input: NoteInput): string {
  const { from, to, mode, selection } = input;
  if (mode === "overview") return "Notes for this release, not an upgrade history.";
  if (mode === "history")
    return "Your earlier version kept no record of what you had seen, so here is every recorded change.";
  if (selection.boundaryUnknown) return "What this release itself brings.";
  if (from && isAlphaVersion(from) && isAlphaVersion(to))
    return "Only changes added after your previous alpha.";
  const releases = selection.releases.length;
  const complete = selection.coverage === "complete";
  if (releases <= 1)
    return complete
      ? "Everything new since the version you last opened."
      : "What is new since the version you last opened, as far as the notes reach.";
  const many = `${NUMBER_WORDS[releases] ?? String(releases)} releases since the version you last opened`;
  return complete ? `${many}, in one complete briefing.` : `${many}.`;
}

export function renderNote(input: NoteInput): NoteText {
  const { from, to, selection } = input;
  const parts = [rangeLine(input)];
  const previous = from ? escapeHtml(versionName(from)) : "";

  if (selection.coverage === "unavailable") {
    parts.push(
      warning(
        `The notes this version carries could not be read, so I cannot show what changed${previous ? ` since ${previous}` : ""}.`,
      ),
      "<p>The app is ready to use. Closing this note keeps it closed.</p>",
      `<p class="inf-muted">Incomplete history · your work remains available</p>`,
    );
    return { title: "Your app is updated", body: parts.join("") };
  }

  const listed = listedEntries(selection);
  if (selection.boundaryUnknown)
    parts.push(
      warning(
        `I have no notes for ${previous}, the version you last opened. These notes cover this release only.`,
      ),
    );
  if (selection.previousIncomplete)
    parts.push(
      warning(
        `The notes for ${previous} are incomplete, so some of these may be changes you already had.`,
      ),
    );
  if (selection.diverged)
    parts.push(
      `<p class="inf-muted">${capitalized(previous)} had changes this version does not include. Only the changes in this version are listed.</p>`,
    );

  if (listed.length === 0) {
    const promoted = promotion(from, to);
    parts.push(
      promoted
        ? "<p>The same changes you had in alpha, now released as stable.</p>"
        : "<p>Nothing in this version is new to you.</p>",
      `<div class="inf-panel"><h3>No new changes</h3><p>${
        promoted
          ? "This promotion does not repeat your alpha’s notes."
          : "Every change it carries was in the version you last opened or in an earlier note."
      }</p></div>`,
      `<p class="inf-muted">${
        selection.coverage === "complete"
          ? `Verified ${promoted ? "promotion" : "update"} · no repeated changes`
          : "Incomplete history · your work remains available"
      }</p>`,
    );
    return {
      title: promoted ? "Your alpha is now stable" : "Your app is updated",
      body: parts.join(""),
    };
  }

  const top = highlights(listed);
  parts.push(
    `<p>${deck(input)}</p>`,
    highlightsBlock(top, input.pictures),
    allChanges(selection, top.length === 0),
    `<p class="inf-muted">${
      selection.coverage === "complete"
        ? "Notes carried in this version · available offline"
        : "Incomplete history · available offline"
    }</p>`,
    `<p>${READ_AGAIN}</p>`,
  );
  return { title: `What’s new in ${versionName(to)}`, body: parts.join("") };
}
