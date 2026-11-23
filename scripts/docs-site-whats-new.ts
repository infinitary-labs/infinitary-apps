import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * The docs site's What's new page (docs/docs-site.md, "Generated pages"),
 * written from the release-notes ledger when the site is built, so it
 * lists what the newest stable releases changed for people in the words
 * their notes were reviewed in. A release's changes are its membership less
 * the release before it, as the startup note measures them
 * (docs/release-notes.md): backfilled history and maintenance are left out,
 * and the rest is grouped by area in the app's order, features first.
 *
 * Membership comes from each release's committed manifest, or is derived
 * from its tag as `release-notes.ts manifest` derives it, so the checkout
 * needs full history and tags. The page is not committed: a release is a
 * tag, not a commit, and the page would be out of step after every one.
 *
 *   node scripts/docs-site-whats-new.ts   writes docs-site/src/content/docs/whats-new.md
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WHATS_NEW_PAGE = "docs-site/src/content/docs/whats-new.md";

/** How many stable releases the page lists, newest first: a page a person reads, not the archive. */
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

export function whatsNewPage(
  releases: { release: ListedRelease; before: ListedRelease | null }[],
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
    "Each stable release of Infinitary, newest first, and what it changed for you.",
    "When Infinitary updates, its first card says what is new since the version you used before.",
    "To read that card again, open command search and run **Show what's new**, or on a Mac choose **What's New** in the **Help** menu.",
  ];
  for (const { release, before } of releases) {
    const changes = releaseChanges(release, before, entries);
    lines.push("", `## ${release.version}`, "", `Released ${release.date}.`);
    if (changes.length === 0) lines.push("", "Nothing in this release changed what you see.");
    for (const area of NOTE_AREAS) {
      const here = changes.filter((entry) => (entry.area ?? "other") === area.id);
      if (here.length === 0) continue;
      lines.push("", `### ${area.label}`, "");
      for (const entry of here)
        lines.push(
          `- **${KIND_WORDS[entry.kind] ?? entry.kind}:** ${prose(entry.title)}${entry.body ? `  \n  ${prose(entry.body)}` : ""}`,
        );
    }
  }
  return `${lines.join("\n")}\n`;
}

function manifestOf(version: string, root: string): ListedRelease {
  const committed = join(root, "release-notes", "releases", `${version}.json`);
  const text = existsSync(committed)
    ? readFileSync(committed, "utf8")
    : run(["manifest", "--version", version, "--repo", root]);
  return JSON.parse(text) as ListedRelease;
}

export function newestStables(root = ROOT): { release: ListedRelease; before: ListedRelease | null }[] {
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
  return versions.slice(0, STABLES_LISTED).map((version, index) => {
    const previous = versions[index + 1];
    return { release: manifestOf(version, root), before: previous ? manifestOf(previous, root) : null };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(join(ROOT, WHATS_NEW_PAGE), whatsNewPage(newestStables(), ledgerEntries()));
  console.log(`wrote ${WHATS_NEW_PAGE}`);
}
