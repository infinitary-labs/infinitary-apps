import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_FILE,
  ENTRY_KINDS,
  NOTE_AREAS,
  parseArchive,
  type NoteEntry,
  type ReleaseManifest,
} from "../src/core/releaseNotes/catalog.ts";
import { compareSemver, isStableVersion } from "../src/shared/semver.ts";
import { ledgerProblems, run } from "./release-notes.ts";

/**
 * The docs site's What's new pages (docs/docs-site.md, "Generated pages"),
 * written from the release-notes ledger when the site is built, so they
 * say what each stable release changed for people in the words their notes
 * were reviewed in: What's new shows the newest stables and an index of
 * every stable with changes, and each of those has a page of its own, so a
 * release stays on the site after it leaves What's new. A release's changes are its membership less
 * the release before it, as the startup note measures them
 * (docs/release-notes.md): backfilled history and maintenance are left out,
 * and the rest is grouped by area in the app's order, features first.
 *
 * Membership comes from each release's committed manifest, or is derived
 * from its tag as `release-notes.ts manifest` derives it, so the checkout
 * needs full history and tags. The pages are not committed: a release is a
 * tag, not a commit, and the pages would be out of step after every one.
 *
 *   node scripts/docs-site-whats-new.ts   writes docs-site/src/content/docs/whats-new.md and whats-new/
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WHATS_NEW_PAGE = "docs-site/src/content/docs/whats-new.md";
/** Each stable's own page, one file per version; the folder holds nothing else, so each build replaces it whole. */
export const RELEASE_PAGES = "docs-site/src/content/docs/whats-new";

/** How many stable releases What's new shows, newest first: the rest are a line each in its index. */
const STABLES_LISTED = 5;

/** Each kind as the startup note names it (`src/core/releaseNotes/briefing.ts`). */
const KIND_WORDS: Record<string, string> = {
  feature: "Added",
  improvement: "Improved",
  fix: "Fixed",
  removal: "Removed",
};

export type ListedRelease = Pick<ReleaseManifest, "version" | "date" | "entryIds">;

export function ledgerEntries(root = ROOT): Map<string, NoteEntry> {
  const entries = new Map<string, NoteEntry>();
  for (const folder of ["changes", "history"]) {
    const dir = join(root, "release-notes", folder);
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
      const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as { entries?: NoteEntry[] };
      for (const entry of file.entries ?? []) entries.set(entry.id, entry);
    }
  }
  return entries;
}

/** Whether a person is told about an entry: not backfilled history, not maintenance. */
function told(entry: NoteEntry | undefined): entry is NoteEntry {
  return (
    entry !== undefined &&
    entry.provenance.origin !== "changelog-backfill" &&
    entry.kind !== "maintenance"
  );
}

export function releaseChanges(
  release: ListedRelease,
  before: ListedRelease | null,
  entries: Map<string, NoteEntry>,
): NoteEntry[] {
  const earlier = new Set(before?.entryIds ?? []);
  const kinds: readonly string[] = ENTRY_KINDS;
  return release.entryIds
    .filter((id) => !earlier.has(id))
    .map((id) => entries.get(id))
    .filter(told)
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
}

/** Prose from a note, with nothing Markdown would read as its own markup. */
function prose(text: string): string {
  return text.replace(/[\\`*_[\]<>#|{}]/g, (character) => `\\${character}`);
}

export type StableRelease = { release: ListedRelease; before: ListedRelease | null };

/** A stable's own page's file name, and so its address under /whats-new/: 0.8.6 is 0-8-6. */
export function releaseSlug(version: string): string {
  return version.replaceAll(".", "-");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * A release's changes grouped under their areas' headings, each note's title
 * shown and its detail folded under it, as the app's What's new card folds
 * them. A <details> block is raw HTML up to its first blank line, so the
 * title is escaped as HTML and the detail after the blank line as Markdown.
 */
function changesByArea(changes: NoteEntry[], heading: string): string[] {
  const lines: string[] = [];
  for (const area of NOTE_AREAS) {
    const here = changes.filter((entry) => (entry.area ?? "other") === area.id);
    if (here.length === 0) continue;
    lines.push("", `${heading} ${area.label}`);
    for (const entry of here) {
      const title = `<strong>${escapeHtml(KIND_WORDS[entry.kind] ?? entry.kind)}:</strong> ${escapeHtml(entry.title)}`;
      lines.push("", "<details>", `<summary>${title}</summary>`);
      if (entry.body) lines.push("", prose(entry.body));
      lines.push("", "</details>");
    }
  }
  return lines;
}

function changeCount(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

export function whatsNewPage(
  releases: StableRelease[],
  entries: Map<string, NoteEntry>,
): string {
  const lines = [
    "---",
    "title: What's new",
    "description: What changed for you in each recent stable release of Infinitary.",
    "---",
    "",
    "<!-- Written by node scripts/docs-site-whats-new.ts from release-notes/ when the site is built. -->",
    "",
    "Each recent stable release of Infinitary, newest first, and what it changed for you.",
    "Select a change to read more about it.",
    "Every release also has a page of its own, listed under [Every release](#every-release).",
    "When Infinitary updates, its first card says what is new since the version you used before.",
    "To read that card again, open command search and run **Show what's new**, or on a Mac choose **What's New** in the **Help** menu.",
  ];
  const listed: { release: ListedRelease; count: number }[] = [];
  for (const [index, { release, before }] of releases.entries()) {
    const changes = releaseChanges(release, before, entries);
    if (changes.length > 0) listed.push({ release, count: changes.length });
    if (index >= STABLES_LISTED) continue;
    lines.push("", `## ${release.version}`, "");
    if (changes.length === 0) {
      lines.push(`Released ${release.date}.`, "", "Nothing in this release changed what you see.");
      continue;
    }
    lines.push(
      `Released ${release.date}, with ${changeCount(changes.length)}. [Read ${release.version} on its own page](/whats-new/${releaseSlug(release.version)}/).`,
    );
    lines.push(...changesByArea(changes, "###"));
  }
  lines.push("", "## Every release", "", "Each stable release that changed what you see, newest first.", "");
  for (const { release, count } of listed)
    lines.push(
      `- [${release.version}](/whats-new/${releaseSlug(release.version)}/), released ${release.date}, with ${changeCount(count)}`,
    );
  return `${lines.join("\n")}\n`;
}

/** A stable's own page, or null when it changed nothing a person sees. */
export function releasePage(
  { release, before }: StableRelease,
  entries: Map<string, NoteEntry>,
): string | null {
  const changes = releaseChanges(release, before, entries);
  if (changes.length === 0) return null;
  const lines = [
    "---",
    `title: What's new in ${release.version}`,
    `description: What changed for you in Infinitary ${release.version}, released ${release.date}.`,
    "---",
    "",
    "<!-- Written by node scripts/docs-site-whats-new.ts from release-notes/ when the site is built. -->",
    "",
    `Released ${release.date}, with ${changeCount(changes.length)} since ${before ? before.version : "the first release"}.`,
    "Select a change to read more about it.",
    "Every stable release is listed on [What's new](/whats-new/#every-release).",
    ...changesByArea(changes, "##"),
  ];
  return `${lines.join("\n")}\n`;
}

function manifestOf(version: string, root: string): ListedRelease {
  const committed = join(root, "release-notes", "releases", `${version}.json`);
  const text = existsSync(committed)
    ? readFileSync(committed, "utf8")
    : run(["manifest", "--version", version, "--repo", root]);
  return JSON.parse(text) as ListedRelease;
}

/** Every stable release, newest first, each with the stable before it. */
export function stableReleases(root = ROOT): StableRelease[] {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("rev-parse", "--is-shallow-repository") === "true")
    throw new Error(
      "What's new reads every stable release's tag: fetch full history and tags (fetch-depth: 0)",
    );
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean).map((tag) => tag.slice(1));
  const archivePath = join(root, ARCHIVE_FILE);
  const pins = existsSync(archivePath)
    ? parseArchive(JSON.parse(readFileSync(archivePath, "utf8")), ARCHIVE_FILE)
    : null;
  if (pins) {
    if (!pins.archive) throw new Error(pins.problems.join("\n"));
    const problems = ledgerProblems(root);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }
  const versions = [...new Set([...tags, ...Object.keys(pins?.archive?.releases ?? {})])]
    .filter(isStableVersion)
    .sort((a, b) => compareSemver(b, a) ?? 0);
  return versions.map((version, index) => {
    const previous = versions[index + 1];
    return { release: manifestOf(version, root), before: previous ? manifestOf(previous, root) : null };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releases = stableReleases();
  const entries = ledgerEntries();
  writeFileSync(join(ROOT, WHATS_NEW_PAGE), whatsNewPage(releases, entries));
  const folder = join(ROOT, RELEASE_PAGES);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder);
  let written = 0;
  for (const stable of releases) {
    const page = releasePage(stable, entries);
    if (page === null) continue;
    writeFileSync(join(folder, `${releaseSlug(stable.release.version)}.md`), page);
    written += 1;
  }
  console.log(`wrote ${WHATS_NEW_PAGE} and ${written} pages in ${RELEASE_PAGES}/`);
}
